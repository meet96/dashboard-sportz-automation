import assert from "node:assert";
import { fetchCricbuzzWithDeps, CricbuzzRotationState } from "../src/lib/cricbuzzClient";

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function freshState(): CricbuzzRotationState {
  return { cursor: 0, exhausted: new Map() };
}

async function main() {
  // Case 1: first key quota-exceeded (403), second key succeeds. Cursor advances past it.
  {
    const calls: number[] = [];
    const fetchImpl = (async (_url: string, opts: { headers: Record<string, string> }) => {
      const idx = opts.headers["X-RapidAPI-Key"] === "key0" ? 0 : 1;
      calls.push(idx);
      return idx === 0 ? fakeResponse(403, { message: "quota exceeded" }) : fakeResponse(200, { state: "Complete" });
    }) as unknown as typeof fetch;

    const state = freshState();
    const result = await fetchCricbuzzWithDeps(
      "/path",
      { fetchImpl, keys: ["key0", "key1"], host: "h", now: () => new Date("2026-08-07") },
      state
    );
    assert.deepStrictEqual(result, { state: "Complete" });
    assert.deepStrictEqual(calls, [0, 1]);
    assert.strictEqual(state.cursor, 0); // (1 + 1) % 2
    assert.strictEqual(state.exhausted.get(0), "2026-08");
  }

  // Case 2: a key already marked exhausted this month is skipped without a network call.
  {
    const calls: number[] = [];
    const fetchImpl = (async (_url: string, opts: { headers: Record<string, string> }) => {
      calls.push(opts.headers["X-RapidAPI-Key"] === "key0" ? 0 : 1);
      return fakeResponse(200, { state: "Complete" });
    }) as unknown as typeof fetch;

    const state: CricbuzzRotationState = { cursor: 0, exhausted: new Map([[0, "2026-08"]]) };
    await fetchCricbuzzWithDeps(
      "/path",
      { fetchImpl, keys: ["key0", "key1"], host: "h", now: () => new Date("2026-08-07") },
      state
    );
    assert.deepStrictEqual(calls, [1]);
  }

  // Case 3: an exhausted mark from a previous month is treated as stale and retried.
  {
    const fetchImpl = (async () => fakeResponse(200, { state: "Complete" })) as unknown as typeof fetch;
    const state: CricbuzzRotationState = { cursor: 0, exhausted: new Map([[0, "2026-07"]]) };
    await fetchCricbuzzWithDeps(
      "/path",
      { fetchImpl, keys: ["key0", "key1"], host: "h", now: () => new Date("2026-08-07") },
      state
    );
    assert.strictEqual(state.exhausted.has(0), false);
  }

  // Case 4: every key exhausted -> throws a clear aggregate error.
  {
    const fetchImpl = (async () => fakeResponse(429, { message: "rate limited" })) as unknown as typeof fetch;
    const state = freshState();
    await assert.rejects(
      () =>
        fetchCricbuzzWithDeps(
          "/path",
          { fetchImpl, keys: ["key0", "key1"], host: "h", now: () => new Date("2026-08-07") },
          state
        ),
      /quota/
    );
  }

  // Case 5: a non-quota HTTP error (500) throws immediately, without trying the next key.
  {
    const calls: number[] = [];
    const fetchImpl = (async (_url: string, opts: { headers: Record<string, string> }) => {
      calls.push(opts.headers["X-RapidAPI-Key"] === "key0" ? 0 : 1);
      return fakeResponse(500, { message: "server error" });
    }) as unknown as typeof fetch;
    const state = freshState();
    await assert.rejects(
      () =>
        fetchCricbuzzWithDeps(
          "/path",
          { fetchImpl, keys: ["key0", "key1"], host: "h", now: () => new Date("2026-08-07") },
          state
        ),
      /Cricbuzz API error 500/
    );
    assert.deepStrictEqual(calls, [0]);
  }

  // Case 6: no keys configured -> clear error, no network call attempted.
  {
    const fetchImpl = (async () => fakeResponse(200, {})) as unknown as typeof fetch;
    const state = freshState();
    await assert.rejects(
      () => fetchCricbuzzWithDeps("/path", { fetchImpl, keys: [], host: "h", now: () => new Date() }, state),
      /No CRICBUZZ_API_KEYS configured/
    );
  }

  console.log("PASS: smoke-cricbuzz-client");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
