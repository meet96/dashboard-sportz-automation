# Cricbuzz Key Rotation + Sweep/Live Job Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop wasting Cricbuzz API quota — round-robin calls across multiple RapidAPI keys instead of one, and merge the two recurring jobs (sweep + live-check) into one so they stop independently re-checking the same match's status.

**Architecture:** A new `cricbuzzClient.ts` module centralizes all Cricbuzz HTTP calls behind a key-rotating fetcher. `checkAndScoreMatches.ts`'s existing (targeted-run-only) live-scoring/contest-gating logic gets extended to the recurring sweep path via one new parameter on its pure decision function; `checkLiveMatches.ts` is deleted as redundant once that's done.

**Tech Stack:** Node/TypeScript, Agenda, MongoDB/Mongoose, RapidAPI (Cricbuzz).

## Global Constraints

- Quota/subscription errors from Cricbuzz are HTTP 403 or 429 — these (and only these) trigger key rotation to the next key.
- Any other HTTP error status (5xx, 404, etc.) throws immediately — never treated as a rotation trigger.
- `CRICBUZZ_API_KEYS` is comma-separated (replaces the old singular `CRICBUZZ_API_KEY`). `CRICBUZZ_API_HOST` stays a single shared value across all keys.
- Exhausted-key tracking is in-memory only, keyed by a `"YYYY-MM"` month string; a mark from a prior month is treated as stale/cleared, not carried forward.
- Round-robin cursor only advances on a successful call.
- `decideMatchAction`'s action-priority order (highest to lowest): `no-result` → past 48h absolute cap → `isFinished` → `isLive` → past 12h soft-stale cap → `skip-not-finished`.
- ESPN/football status checks are out of scope — no key, no quota, unaffected by any of this.
- Default sweep interval: 15 minutes, overridable via `SWEEP_INTERVAL_MINUTES` env var.

---

### Task 1: `cricbuzzClient.ts` — key-rotating fetcher

**Files:**
- Create: `src/lib/cricbuzzClient.ts`
- Test: `scripts/smoke-cricbuzz-client.ts`

**Interfaces:**
- Produces: `fetchCricbuzz(path: string): Promise<Record<string, unknown>>` — the production entry point, used by Task 2. Reads `CRICBUZZ_API_KEYS`/`CRICBUZZ_API_HOST` from `process.env` and the real global `fetch`.
- Produces (for testing): `fetchCricbuzzWithDeps(path, deps, state)` — same logic with injected `fetchImpl`/`keys`/`host`/`now`, and an injected rotation `state` object, so tests don't need to mock global `fetch` or env vars.

- [ ] **Step 1: Write `src/lib/cricbuzzClient.ts`**

```ts
// Shared key-rotating Cricbuzz (RapidAPI) fetcher. Both fetchCricbuzzMatchStatus
// (cricbuzzStatus.ts) and fetchCricbuzzScorecard (cricbuzz.ts) delegate to this instead of each
// doing their own single-key fetch -- lets the service spread calls across multiple RapidAPI keys
// (each with its own monthly quota) instead of being capped by one key's limit.

export interface CricbuzzFetchDeps {
  fetchImpl: typeof fetch;
  keys: string[];
  host: string;
  now: () => Date;
}

export interface CricbuzzRotationState {
  cursor: number;
  exhausted: Map<number, string>;
}

function currentMonthKey(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function isQuotaError(status: number): boolean {
  return status === 403 || status === 429;
}

export async function fetchCricbuzzWithDeps(
  path: string,
  deps: CricbuzzFetchDeps,
  state: CricbuzzRotationState
): Promise<Record<string, unknown>> {
  const { fetchImpl, keys, host, now } = deps;
  if (keys.length === 0) throw new Error("No CRICBUZZ_API_KEYS configured");

  const month = currentMonthKey(now());
  for (const [idx, markedMonth] of state.exhausted) {
    if (markedMonth !== month) state.exhausted.delete(idx);
  }

  const order = keys.map((_, i) => (state.cursor + i) % keys.length);
  let lastError: Error | null = null;

  for (const idx of order) {
    if (state.exhausted.get(idx) === month) continue;

    const url = `https://${host}${path}`;
    const res = await fetchImpl(url, {
      headers: { "X-RapidAPI-Key": keys[idx], "X-RapidAPI-Host": host },
      cache: "no-store" as RequestCache,
    });

    if (res.ok) {
      state.cursor = (idx + 1) % keys.length;
      return (await res.json()) as Record<string, unknown>;
    }

    if (isQuotaError(res.status)) {
      state.exhausted.set(idx, month);
      lastError = new Error(`Cricbuzz key #${idx} quota/subscription error ${res.status}`);
      continue;
    }

    // Non-quota HTTP error -- not a rotation trigger, fail immediately (retrying another key
    // wouldn't fix a real API/data problem, and would mask it).
    const body = await res.text();
    throw new Error(`Cricbuzz API error ${res.status}: ${body}`);
  }

  throw lastError ?? new Error("All Cricbuzz API keys exhausted or unavailable this month");
}

const singletonState: CricbuzzRotationState = { cursor: 0, exhausted: new Map() };

function parseKeys(): string[] {
  return (process.env.CRICBUZZ_API_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

export async function fetchCricbuzz(path: string): Promise<Record<string, unknown>> {
  const host = process.env.CRICBUZZ_API_HOST ?? "cricbuzz-cricket.p.rapidapi.com";
  return fetchCricbuzzWithDeps(
    path,
    { fetchImpl: fetch, keys: parseKeys(), host, now: () => new Date() },
    singletonState
  );
}
```

- [ ] **Step 2: Write `scripts/smoke-cricbuzz-client.ts`**

```ts
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
```

- [ ] **Step 3: Run the smoke test**

Run: `npx tsx scripts/smoke-cricbuzz-client.ts`
Expected: `PASS: smoke-cricbuzz-client`

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (clean)

- [ ] **Step 5: Commit**

```bash
git add src/lib/cricbuzzClient.ts scripts/smoke-cricbuzz-client.ts
git commit -m "Add key-rotating Cricbuzz fetcher (cricbuzzClient.ts)"
```

---

### Task 2: Wire `cricbuzzStatus.ts` and `cricbuzz.ts` to the new client; update `.env`

**Files:**
- Modify: `src/lib/cricbuzzStatus.ts`
- Modify: `src/lib/cricbuzz.ts` (only the `fetchCricbuzzScorecard` function and its doc comment, lines 1-12 and 483-520 — the rest of the file, name-matching/parsing/points logic, is untouched)
- Modify: `.env`

**Interfaces:**
- Consumes: `fetchCricbuzz(path: string): Promise<Record<string, unknown>>` from Task 1.
- Produces: `fetchCricbuzzMatchStatus`/`fetchCricbuzzScorecard` keep their exact existing signatures and return shapes — this task is pure internal plumbing, no caller elsewhere in the codebase needs to change.

- [ ] **Step 1: Replace `fetchCricbuzzMatchStatus`'s body in `src/lib/cricbuzzStatus.ts`**

Replace the whole function (currently lines 49-76) with:

```ts
import { fetchCricbuzz } from "./cricbuzzClient";

export async function fetchCricbuzzMatchStatus(matchId: string): Promise<CricbuzzMatchStatus> {
  const data = (await fetchCricbuzz(`/mcenter/v1/${encodeURIComponent(matchId)}`)) as {
    state?: string;
    status?: string;
  };
  const state = String(data.state ?? "");
  const normalized = state.trim().toLowerCase();
  const isFinished = TERMINAL_STATES.has(normalized);
  const isNotStarted = NOT_STARTED_STATES.has(normalized);
  return {
    state,
    status: String(data.status ?? ""),
    isFinished,
    isNoResult: NO_RESULT_STATES.has(normalized),
    isLive: !isFinished && !isNotStarted,
  };
}
```

Add the `import { fetchCricbuzz } from "./cricbuzzClient";` line near the top of the file (with the other imports, if any — currently this file has none, so add it as the first line).

- [ ] **Step 2: Replace `fetchCricbuzzScorecard`'s body in `src/lib/cricbuzz.ts`**

Add near the top of the file (after the existing file-header comment block, before the `PlayerStats` interface):

```ts
import { fetchCricbuzz } from "./cricbuzzClient";
```

Replace the whole `fetchCricbuzzScorecard` function (currently lines 483-520) with:

```ts
export async function fetchCricbuzzScorecard(cricbuzzMatchId: string): Promise<unknown[]> {
  const data = await fetchCricbuzz(`/mcenter/v1/${encodeURIComponent(cricbuzzMatchId)}/hscard`);
  const scoreCard = data.scoreCard ?? data.scorecard;
  if (!Array.isArray(scoreCard)) {
    throw new Error(
      "Invalid Cricbuzz response: missing scoreCard array. Response keys: " + Object.keys(data).join(", ")
    );
  }
  return scoreCard as unknown[];
}
```

Update the file's header doc comment (lines 9-11) from:
```
 *   CRICBUZZ_API_KEY   — RapidAPI key
 *   CRICBUZZ_API_HOST  — optional, defaults to "cricbuzz-cricket.p.rapidapi.com"
```
to:
```
 *   CRICBUZZ_API_KEYS  — comma-separated RapidAPI keys (round-robined; see cricbuzzClient.ts)
 *   CRICBUZZ_API_HOST  — optional, defaults to "cricbuzz-cricket.p.rapidapi.com"
```

- [ ] **Step 3: Update `.env`**

Replace:
```
# Cricbuzz (RapidAPI) — dedicated key for this service, separate from the main app's
CRICBUZZ_API_KEY=5f859b335cmsha694cfb7592538ep154862jsnf3fb17ec78fc
CRICBUZZ_API_HOST=cricbuzz-cricket.p.rapidapi.com
```
with:
```
# Cricbuzz (RapidAPI) — pool of dedicated keys for this service, round-robined across calls so
# quota scales with the number of keys (each has its own monthly cap). Comma-separated.
CRICBUZZ_API_KEYS=5f859b335cmsha694cfb7592538ep154862jsnf3fb17ec78fc,2934753593mshdfa7cda190bfb3bp155804jsn4f01fcb29d18
CRICBUZZ_API_HOST=cricbuzz-cricket.p.rapidapi.com
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (clean)

- [ ] **Step 5: Real-call verification**

Run this one-off command (not saved as a script — single manual check, mirrors the key-verification calls already done earlier this session):

```bash
node -e "
require('dotenv').config({ quiet: true });
require('tsx/cjs');
const { fetchCricbuzzMatchStatus } = require('./src/lib/cricbuzzStatus.ts');
fetchCricbuzzMatchStatus('151004').then(s => console.log(JSON.stringify(s, null, 2)));
"
```

Expected: valid JSON with a `state` field (e.g. `"Complete"`), confirming the new client path works end to end against the real API with the real keys now in `.env`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/cricbuzzStatus.ts src/lib/cricbuzz.ts .env
git commit -m "Route Cricbuzz status/scorecard calls through the key-rotating client"
```

---

### Task 3: Extend `decideMatchAction` with `isLive`

**Files:**
- Modify: `src/jobs/checkAndScoreMatches.ts` (the `decideMatchAction` function, currently lines 36-57, and its call site, currently line 240)
- Modify: `scripts/smoke-job-logic.ts`

**Interfaces:**
- Consumes: nothing new — `isLive` is already computed a few lines above the call site (from `fetchCricbuzzMatchStatus`/`fetchEspnMatchStatus`), just not threaded into `decideMatchAction` yet.
- Produces: `decideMatchAction(match, isFinished, nowMs, isNoResult?, isLive?): MatchAction` — same return type as before, now capable of returning `"scored-live"` too. The dispatch loop already handles that action generically (existing code, unchanged) — see Task 4's note confirming no further dispatch-loop changes are needed.

- [ ] **Step 1: Update `decideMatchAction`**

Replace (currently lines 36-57):

```ts
export function decideMatchAction(
  match: { date: Date; cricbuzzMatchId?: string | null },
  isFinished: boolean,
  nowMs: number,
  isNoResult: boolean = false
): MatchAction {
  const isFootball = (match.cricbuzzMatchId ?? "").startsWith("espn:");
  const startMs = new Date(match.date).getTime();
  const pastStale = nowMs - startMs > STALE_CAP_MS;
  const pastAbsoluteCap = nowMs - startMs > ABSOLUTE_CAP_MS;

  if (isNoResult) return "no-result";
  if (pastAbsoluteCap) return "stale";
  if (isFinished) return isFootball ? "score-football" : "score-cricket";
  if (pastStale) return "stale";
  return "skip-not-finished";
}
```

with:

```ts
export function decideMatchAction(
  match: { date: Date; cricbuzzMatchId?: string | null },
  isFinished: boolean,
  nowMs: number,
  isNoResult: boolean = false,
  isLive: boolean = false
): MatchAction {
  const isFootball = (match.cricbuzzMatchId ?? "").startsWith("espn:");
  const startMs = new Date(match.date).getTime();
  const pastStale = nowMs - startMs > STALE_CAP_MS;
  const pastAbsoluteCap = nowMs - startMs > ABSOLUTE_CAP_MS;

  if (isNoResult) return "no-result";
  if (pastAbsoluteCap) return "stale";
  if (isFinished) return isFootball ? "score-football" : "score-cricket";
  if (isLive) return "scored-live";
  if (pastStale) return "stale";
  return "skip-not-finished";
}
```

- [ ] **Step 2: Update the call site**

Replace (currently line 238-240):

```ts
      let action = isTargetedRun
        ? decideForcedMatchAction(match, isFinished, isNoResult, isLive)
        : decideMatchAction(match, isFinished, Date.now(), isNoResult);
```

with:

```ts
      let action = isTargetedRun
        ? decideForcedMatchAction(match, isFinished, isNoResult, isLive)
        : decideMatchAction(match, isFinished, Date.now(), isNoResult, isLive);
```

- [ ] **Step 3: Add new smoke test cases to `scripts/smoke-job-logic.ts`**

Insert immediately after the existing block ending at line 55 (`assert.strictEqual(decideMatchAction(... startedWayLongAgo ... espn:999 ...), "stale");`) and before the `// --- decideForcedMatchAction ...` comment on line 57:

```ts
  // Finding (live scoring merge): decideMatchAction now also considers isLive, mirroring
  // decideForcedMatchAction's live handling but still subject to the staleness caps.
  assert.strictEqual(
    decideMatchAction({ date: startedRecently, cricbuzzMatchId: "12345" }, false, now, false, true),
    "scored-live"
  );
  assert.strictEqual(
    decideMatchAction({ date: startedRecently, cricbuzzMatchId: "espn:999" }, false, now, false, true),
    "scored-live"
  );
  // Finished still wins over live (authoritative outcome, matching decideForcedMatchAction's
  // equivalent case below).
  assert.strictEqual(
    decideMatchAction({ date: startedRecently, cricbuzzMatchId: "12345" }, true, now, false, true),
    "score-cricket"
  );
  // Live wins over the 12h soft-stale cap -- a long-running live match (e.g. a Test) keeps
  // getting live-scored past 12h, unlike a genuinely stuck (not live, not finished) match.
  const startedPastSoftCap = new Date(now - 13 * 60 * 60 * 1000); // 13h ago, past the 12h cap
  assert.strictEqual(
    decideMatchAction({ date: startedPastSoftCap, cricbuzzMatchId: "12345" }, false, now, false, true),
    "scored-live"
  );
  // The 48h absolute cap still wins over live -- hard ceiling regardless of provider-reported state.
  assert.strictEqual(
    decideMatchAction({ date: startedWayLongAgo, cricbuzzMatchId: "12345" }, false, now, false, true),
    "stale"
  );
```

- [ ] **Step 4: Run the smoke test**

Run: `npx tsx scripts/smoke-job-logic.ts`
Expected: `PASS: smoke-job-logic`

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (clean)

- [ ] **Step 6: Commit**

```bash
git add src/jobs/checkAndScoreMatches.ts scripts/smoke-job-logic.ts
git commit -m "Extend decideMatchAction with isLive so the sweep can live-score directly"
```

---

### Task 4: Delete `checkLiveMatches.ts`; update `server.ts` and `scripts/toggle-sweep.ts`

**Files:**
- Delete: `src/jobs/checkLiveMatches.ts`
- Delete: `scripts/smoke-live-job-logic.ts`
- Modify: `src/server.ts`
- Modify: `scripts/toggle-sweep.ts`

**Interfaces:**
- Consumes: `JOB_NAME` from `checkAndScoreMatches.ts` (already exported, unchanged).
- Produces: nothing new — this task only removes the now-redundant second job and its schedule.

- [ ] **Step 1: Delete the two files**

```bash
git rm src/jobs/checkLiveMatches.ts scripts/smoke-live-job-logic.ts
```

- [ ] **Step 2: Update `src/server.ts`**

Remove this import line:
```ts
import { defineCheckLiveMatchesJob, LIVE_JOB_NAME } from "./jobs/checkLiveMatches";
```

Replace the `startAgenda` function body (currently, as of this plan being written):

```ts
export async function startAgenda() {
  await connectDB();
  agenda = new Agenda({ db: { address: process.env.MONGODB_URI! } });
  defineCheckAndScoreJob(agenda);
  defineCheckLiveMatchesJob(agenda);
  await agenda.start();
  await agenda.every("5 minutes", JOB_NAME);
  await agenda.every("10 minutes", LIVE_JOB_NAME);
}
```

with:

```ts
export async function startAgenda() {
  await connectDB();
  agenda = new Agenda({ db: { address: process.env.MONGODB_URI! } });
  defineCheckAndScoreJob(agenda);
  await agenda.start();
  const sweepIntervalMinutes = Number(process.env.SWEEP_INTERVAL_MINUTES) || 15;
  await agenda.every(`${sweepIntervalMinutes} minutes`, JOB_NAME);
}
```

- [ ] **Step 3: Update `scripts/toggle-sweep.ts`**

Remove this import line:
```ts
import { LIVE_JOB_NAME } from "../src/jobs/checkLiveMatches";
```

Replace:
```ts
const VALID_JOB_NAMES = [SWEEP_JOB_NAME, LIVE_JOB_NAME];
```
with:
```ts
const VALID_JOB_NAMES = [SWEEP_JOB_NAME];
```

- [ ] **Step 4: Confirm no remaining references**

Run: `grep -rn "checkLiveMatches\|LIVE_JOB_NAME" src/ scripts/`
Expected: no matches (empty output)

- [ ] **Step 5: Typecheck and build**

Run: `npx tsc --noEmit`
Expected: no output (clean)

Run: `npm run build`
Expected: exits 0, no errors

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Remove check-live-matches job -- merged into check-and-score-matches"
```

---

### Task 5: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Run every smoke script**

Run each of the following and confirm each prints its own `PASS:` line with no errors:

```bash
npx tsx scripts/smoke-cricbuzz-client.ts
npx tsx scripts/smoke-job-logic.ts
npx tsx scripts/smoke-models.ts
npx tsx scripts/smoke-cricbuzz-parse.ts
npx tsx scripts/smoke-auth.ts
npx tsx scripts/smoke-routes.ts
npx tsx scripts/smoke-contest-check.ts
npx tsx scripts/smoke-cricbuzz-status.ts
npx tsx scripts/smoke-espn-status.ts
```

(`smoke-live-job-logic.ts` no longer exists — do not run it.)

- [ ] **Step 2: Full typecheck and build**

Run: `npx tsc --noEmit`
Expected: no output

Run: `npm run build`
Expected: exits 0

- [ ] **Step 3: Restart the local dev server and confirm one job registers**

Stop whatever `npm run dev` process is currently running (the merged code needs a real restart — `tsx watch` restarts on source changes automatically, but the developer should confirm it actually picked up the new `startAgenda()` rather than assume). Then, with it running, query the `agendaJobs` collection directly (e.g. a short one-off `node -e` script using `mongoose.connect(process.env.MONGODB_URI)` and `.collection("agendaJobs").find({ repeatInterval: { $exists: true } }).toArray()`, matching the pattern used earlier this session for Agendash investigation) and confirm:
- Exactly **one** recurring job document exists, named `check-and-score-matches`.
- Its `repeatInterval` reads `"15 minutes"` (or whatever `SWEEP_INTERVAL_MINUTES` was set to).
- No `check-live-matches` document exists (or if one exists from before this change, it's a stale leftover — fine to ignore, Agenda won't schedule it since nothing calls `agenda.every()` for that name anymore).

- [ ] **Step 4: One real end-to-end status check**

Run the same one-off `fetchCricbuzzMatchStatus('151004')` check as Task 2 Step 5, confirming the full path (server code, not just the standalone check) still resolves correctly post-merge. This is the only real API call in this verification task — deliberately kept to one, given the whole point of this work is conserving quota.

- [ ] **Step 5: Report**

Summarize for the user: all smoke tests passing, typecheck/build clean, one merged job confirmed running on the new interval, real API call confirmed working through the full new path. Remind them: `CRICBUZZ_API_KEYS` (plural) and `SWEEP_INTERVAL_MINUTES` will need to be set on Railway once this service is deployed there (not yet — deployment is a separate future step).
