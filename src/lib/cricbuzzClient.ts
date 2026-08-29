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
      lastError = new Error(`${host} key #${idx} quota/subscription error ${res.status}`);
      continue;
    }

    // Non-quota HTTP error -- not a rotation trigger, fail immediately (retrying another key
    // wouldn't fix a real API/data problem, and would mask it).
    const body = await res.text();
    throw new Error(`${host} API error ${res.status}: ${body}`);
  }

  throw lastError ?? new Error(`All keys exhausted or unavailable this month for ${host}`);
}

const singletonState: CricbuzzRotationState = { cursor: 0, exhausted: new Map() };

// Exported so other RapidAPI callers on this same key pool (e.g. lib/eplTransfers.ts) can reuse
// fetchCricbuzzWithDeps against a different host with their own rotation state, instead of each
// re-parsing CRICBUZZ_API_KEYS themselves.
export function parseKeys(): string[] {
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
