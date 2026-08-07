# Cricbuzz Key Rotation + Sweep/Live Job Merge

## Problem

The dedicated Cricbuzz RapidAPI key for this service has a 200 requests/month
quota. Two issues compound against that budget:

1. **Redundant status checks.** `check-and-score-matches` (the recurring
   sweep, every 5 min) and `check-live-matches` (every 10 min) both run
   against the same base candidate set (`isCompleted: false`, `noResult:
   false`, `date <= now`, has a `cricbuzzMatchId`). For any match that's
   still active and has a Contest, both jobs independently call
   `fetchCricbuzzMatchStatus` for it — up to 3 calls per 10-minute window
   for one match, when a single shared check covers both purposes.
2. **No time-based polling design fits a 200/month cap.** Even with the
   redundancy removed, a single T20 match's live window (~3.5h) at a
   15-minute cadence costs ~14 status checks, plus a scorecard fetch
   (`fetchCricbuzzScorecard`, a *separate* Cricbuzz call) on every tick it's
   actually live-scored — roughly 30 calls for one contest-having T20's full
   lifecycle. A handful of matches a month can exhaust the quota outright.

The user will supply multiple dedicated Cricbuzz keys over time (2 in hand
now, more later) specifically so quota scales with the number of keys
rather than by starving live-scoring or finalization. This spec covers
building that key rotation and removing the redundant polling.

## Goals

- Combine the sweep and live-check into one job, one status call per
  candidate match per tick.
- Round-robin Cricbuzz calls across N configured keys; on a
  quota/subscription error (403/429) from one key, automatically retry with
  the next key before failing the call.
- Make the poll interval configurable via env var, so it can be tuned from
  Railway without a code deploy as more keys are added.
- No change to football (ESPN) status checks or scoring — ESPN's endpoints
  are public and unaffected by the Cricbuzz quota.

## Non-goals

- Persisting quota usage/history across restarts. An in-memory
  exhausted-key tracker (reset on process restart, and cleared on calendar
  month rollover) is enough — this is a low-traffic service redeployed
  periodically, not a place that needs a database-backed rate limiter.
- Changing the actual scoring logic, contest-gating, or staleness-cap
  semantics. Those are reused as-is.

## Architecture

### 1. `src/lib/cricbuzzClient.ts` (new) — shared key-rotating fetcher

Both existing Cricbuzz call sites (`fetchCricbuzzMatchStatus` in
`cricbuzzStatus.ts`, `fetchCricbuzzScorecard` in `cricbuzz.ts`) currently
each do their own `fetch` + single-key auth header. This new module
centralizes that into one function:

```
fetchCricbuzz(path: string): Promise<Record<string, unknown>>
```

- Reads `CRICBUZZ_API_KEYS` (comma-separated) once, parsed into an ordered
  list.
- Keeps a module-scope round-robin cursor, advanced by one on every
  successful call, so load spreads evenly across keys rather than
  hammering key #1 until it's dead.
- Keeps a module-scope `Map<keyIndex, monthString>` of keys known to be
  exhausted/unsubscribed this month. Before trying a key, skip it if it's
  marked exhausted for the *current* month; entries from a prior month are
  treated as fresh (cheap `YYYY-MM` string comparison, no cron needed).
- On a call: try keys in round-robin order starting from the cursor,
  skipping any marked exhausted this month. If a key's response is 403 or
  429, mark it exhausted for the current month and try the next key. Any
  other error status (5xx, 404, etc.) is NOT a rotation trigger — it
  throws immediately, since that's a real API/data problem no other key
  would fix.
- If every key is exhausted or the list is empty, throw a clear aggregate
  error (e.g. "All N Cricbuzz keys exhausted or unavailable this month").
- `CRICBUZZ_API_HOST` stays a single shared value — same RapidAPI host
  regardless of which key is used.

`fetchCricbuzzMatchStatus` and `fetchCricbuzzScorecard` become thin
callers of `fetchCricbuzz(path)`, dropping their own duplicated fetch/auth
code. Their public signatures and return shapes are unchanged — this is
purely an internal plumbing change, nothing downstream (scoring services,
jobs) needs to know about key rotation.

### 2. Merge `check-live-matches` into `check-and-score-matches`

Reading the current dispatch loop in `checkAndScoreMatches.ts` closely:
the machinery for live-scoring already exists there and is *already*
shared/generic — `decideForcedMatchAction` (used for manually-targeted
runs) already returns `"scored-live"`, the dispatch loop already handles
that action generically (lines handling `action === "scored-live"`), and
the Contest gate (`hasActiveContestForMatch`) is already applied
unconditionally after the action is decided, regardless of whether the run
is targeted. The *only* thing missing is that `decideMatchAction` (used
for the plain recurring sweep, not a targeted run) never considers
`isLive` and never returns `"scored-live"`.

So the merge is small:

- Extend `decideMatchAction`'s signature to accept `isLive: boolean`, and
  add a branch returning `"scored-live"`. Ordering (matching
  `decideForcedMatchAction`'s existing priority, with the two staleness
  caps folded in):
  1. `isNoResult` → `"no-result"` (unchanged, highest priority)
  2. past the 48h absolute cap → `"stale"` (unchanged hard ceiling —
     applies even to a match the provider still claims is live, so a
     perpetually-stuck status can't poll forever)
  3. `isFinished` → `"score-cricket"` / `"score-football"` (unchanged)
  4. `isLive` → `"scored-live"` (new — checked *before* the 12h soft-stale
     cap, so a genuinely long-running live match, e.g. a Test, keeps
     getting live-scored past 12h up to the 48h hard cap, rather than
     being cut off)
  5. past the 12h soft cap → `"stale"` (unchanged — only reachable now for
     matches that are neither finished nor live, i.e. genuinely stuck)
  6. otherwise → `"skip-not-finished"` (unchanged)
- Update the one call site passing `isLive` through (it's already computed
  a few lines above, just not threaded into `decideMatchAction` yet).
- Delete `src/jobs/checkLiveMatches.ts` entirely — `findLiveCandidateMatches`
  used the exact same base query as `findCandidateMatches` (already
  present in `checkAndScoreMatches.ts`), and `liveScoreCricketMatch`/
  `liveScoreFootballMatch` duplicate logic already inlined in the
  `"scored-live"` dispatch branch. No new scoring logic needs to be
  written.
- `server.ts`: remove the `defineCheckLiveMatchesJob`/`LIVE_JOB_NAME`
  import and the separate `agenda.every("10 minutes", LIVE_JOB_NAME)`
  call. One job, one schedule.

A side effect worth calling out: live-scoring now also respects the 48h
absolute staleness cap, which `check-live-matches` never enforced on its
own (it would have polled a stuck-live match indefinitely). Not the point
of this change, but a reasonable improvement that falls out of sharing the
decision function.

### 3. Configurable poll interval

Replace the hardcoded `"5 minutes"` sweep interval with an env var, e.g.
`SWEEP_INTERVAL_MINUTES` (default `15`), read in `server.ts` and passed to
`agenda.every()`. This makes the interval tunable from Railway as more
keys get added to the pool, without a code deploy.

Starting default: **15 minutes**. Rough budget math with the 2 keys in
hand today (400/month combined): a contest-having T20's full lifecycle
(~3.5h live window, 2 Cricbuzz calls per live tick — one status, one
scorecard) costs roughly 30 calls; a non-contest match costs much less
(no scorecard fetches until the single finalize tick). At "moderate"
match volume this is workable but not generous — the env var makes it
easy to loosen as more keys arrive.

### 4. `scripts/toggle-sweep.ts`

Currently imports `LIVE_JOB_NAME` from `checkLiveMatches.ts` and lists
both job names as valid for its `--job` flag. Since there's only one job
after the merge, drop the `LIVE_JOB_NAME` import and reduce
`VALID_JOB_NAMES` to just the sweep job name. The `--job` flag itself can
stay (harmless, and keeps the script's interface stable if another
recurring job is ever added).

### 5. Smoke scripts

- `scripts/smoke-live-job-logic.ts` only tests `checkLiveMatches.ts`'s
  exports (job name constant, `defineCheckLiveMatchesJob` wiring). Delete
  it along with the file it tests.
- `scripts/smoke-job-logic.ts` already has the exact pattern needed for the
  new cases (see its existing `decideForcedMatchAction(..., isLive)`
  assertions around line 104-125). Add equivalent `decideMatchAction(...,
  isLive)` cases: live+not-finished → `"scored-live"`; finished still wins
  over live (authoritative outcome, matching the existing
  `decideForcedMatchAction` case at line 120-125); live wins over the 12h
  soft-stale cap (a long-running live match, e.g. a Test past 12h, still
  live-scores); the 48h absolute cap still wins over live (hard ceiling
  regardless of provider-reported state, matching the existing finished
  case at lines 27-33).

### 6. Env var rename

`CRICBUZZ_API_KEY` (singular) → `CRICBUZZ_API_KEYS` (plural,
comma-separated). This is a clean rename, not a backward-compatible
addition — `cricbuzzClient.ts` only reads the plural form. `.env` gets
updated with both current keys as part of implementation. This also needs
to be set (renamed) on Railway once this service is deployed there —
noted as a follow-up, not part of this change (deployment hasn't happened
yet).

## Data Flow (per candidate match, per tick)

```
fetch status (1 Cricbuzz or ESPN call, via key rotation if Cricbuzz)
  -> isNoResult?        -> mark no-result, done
  -> past 48h cap?      -> mark stale, done
  -> isFinished?        -> finalize score (scorecard fetch + write, isCompleted=true), done
  -> isLive?            -> check hasActiveContestForMatch
                             -> yes -> live-score (scorecard fetch + write, isCompleted stays false)
                             -> no  -> skip-no-contest, done
  -> past 12h cap?      -> mark stale, done
  -> otherwise          -> skip-not-finished, done
```

## Error Handling

- A single exhausted/unsubscribed key never fails a call outright — it's
  skipped in favor of the next key in the pool. Only exhausting *all*
  configured keys fails the call, which surfaces exactly as today's
  "status check failed: <message>" per-match error in the run summary
  (existing behavior, unchanged) — the tick continues to the next
  candidate rather than aborting the whole run.
- Non-quota HTTP errors (5xx, malformed response, etc.) are not treated as
  rotation triggers, to avoid masking real upstream problems by silently
  retrying across keys.

## Testing

- `cricbuzzClient.ts`'s rotation logic is a pure-ish function with an
  injectable fetch implementation (constructor/parameter injection,
  defaulting to global `fetch`), so unit tests can simulate: first key
  returns 403 → second key succeeds; all keys return 429 → aggregate error
  thrown; a key marked exhausted this month is skipped without a network
  call; a key marked exhausted last month is retried.
- `decideMatchAction`'s new `isLive` branch and staleness-cap reordering
  are unit-tested the same way the existing pure decision functions in
  this file already are (no I/O, direct input/output assertions) —
  matching the existing test approach for `decideMatchAction` and
  `decideForcedMatchAction`.
- Real-key verification (no unit-test mocking): after implementation, one
  real call against both configured keys confirms both are live and
  round-robin selection works end to end — already spot-checked manually
  during this session (both keys returned HTTP 200). No need to spend real
  quota deliberately forcing a 403 to prove rotation; that's covered by
  the unit tests with mocked responses.
