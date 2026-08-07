# Manual Scoring Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator force-score a specific match, a few matches, or a whole series on demand from Agendash (or a CLI wrapper), and pause/resume the recurring sweep — without touching the recurring 30-minute schedule's own behavior.

**Architecture:** The existing `check-and-score-matches` Agenda job gains a data-driven branch: when created with target data (matchId/matchIds/leagueCode+series), it resolves and force-scores exactly those matches instead of running the normal candidate sweep. Two new CLI scripts wrap this: one submits a targeted job via Agendash's existing create-job API and polls MongoDB for the result; the other pauses/resumes the recurring job via Agenda's own `disable()`/`enable()`.

**Tech Stack:** Same as the rest of `dashboard-sportz-automation` — Node/TypeScript, Mongoose, Agenda, plain `tsx`+`node:assert` scripts (no test framework).

## Global Constraints

- Full design: `docs/specs/2026-08-07-targeted-manual-scoring-trigger.md`.
- Repo: `c:\Users\tonaj\OneDrive\Documents\vs code\dashboard-sportz-automation`, commit directly to `main` (established convention for this repo).
- Targeted runs bypass `isCompleted`/`noResult`/`date` filters and both staleness caps entirely — a human explicitly asked for these matches, so the guardrails that bound the *unattended* sweep don't apply.
- Targeted runs still call the real live Cricbuzz/ESPN status check per match — never fabricate a score for a match the provider reports as not yet finished.
- `leagueCode` and `series` must both be provided together for series-targeting; one without the other is an explicit, reported error, never silently ignored or run unscoped.
- Invalid/malformed match IDs and IDs that don't resolve to a real match are both reported in the result (`"not-found"` action), never silently dropped.
- The recurring sweep's own behavior, schedule, and guardrails are unchanged by this plan.
- No new HTTP endpoint on the automation service — the CLI trigger wrapper calls Agendash's existing `POST /admin/jobs/api/jobs/create` (verified working during design: `{jobName, jobSchedule, jobData}` body, basic auth via `AGENDASH_USER`/`AGENDASH_PASSWORD`). The pause/resume script talks to Agenda/MongoDB directly since Agendash has no HTTP surface for enable/disable.

---

### Task 1: Targeted-run support in the Agenda job

**Files:**
- Modify: `src/jobs/checkAndScoreMatches.ts`
- Modify: `scripts/smoke-job-logic.ts` (add cases for the new decision function and target parsing)

**Interfaces:**
- Consumes: `Match` model, `LeagueCode` model, `fetchCricbuzzMatchStatus`, `fetchEspnMatchStatus`, the 4 scoring service functions, `resolveClassicScoringTargets` — all already in place, unchanged.
- Produces: `decideForcedMatchAction(match, isFinished, isNoResult?): Exclude<MatchAction, "stale">` — exported, pure, unit-tested, used by Task 2/3's understanding of what a targeted run does (they don't call it directly, but its behavior is what they trigger).
- Produces: `MatchAction` gains a new member `"not-found"`.
- `defineCheckAndScoreJob` behavior changes as described below — no signature change (still `(agenda: Agenda) => void`), so `src/server.ts`'s call site is untouched.

- [ ] **Step 1: Replace `src/jobs/checkAndScoreMatches.ts` with the following complete content**

```typescript
import type { Job } from "agenda";
import mongoose from "mongoose";
import Match, { IMatch } from "../models/Match";
import LeagueCode from "../models/LeagueCode";
import { fetchCricbuzzMatchStatus } from "../lib/cricbuzzStatus";
import { fetchEspnMatchStatus } from "../lib/espnStatus";
import { scoreClassicMatch } from "../services/scoreClassic";
import { scoreFantasy11Match } from "../services/scoreFantasy11";
import { scoreFootballMatch } from "../services/scoreFootball";
import { scoreFootballClassicMatchService } from "../services/scoreFootballClassic";
import { resolveClassicScoringTargets } from "../lib/resolveClassicScoringTargets";

export const JOB_NAME = "check-and-score-matches";
const STALE_CAP_MS = 12 * 60 * 60 * 1000; // 12h past start, never reported finished -> stop auto-retrying
// Absolute ceiling: regardless of the provider's reported status, stop retrying a match more than
// 48h past its start time. This bounds the "finished but the scoring call throws every tick" case
// (missing ScoringConfig, a name-matching bug, provider outage) which the 12h cap above does NOT
// catch, because that cap only fires when a match is still *not finished*. Only applies to the
// recurring sweep's own candidates -- a manually targeted run (Task 1's new capability) always
// bypasses both caps, since a human explicitly asked for that match regardless of its age.
const ABSOLUTE_CAP_MS = 48 * 60 * 60 * 1000;

export type MatchAction =
  | "score-cricket"
  | "score-football"
  | "skip-not-finished"
  | "stale"
  | "no-result"
  | "not-found";

// Pure decision function — no I/O — so it's unit-testable in isolation from the DB/network calls
// that determine `isFinished`/`isNoResult`/`nowMs`. Used by the recurring sweep only.
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

  // Terminal-but-no-play (abandoned/cancelled/no-result/walkover): resolve as no-result instead of
  // scoring an empty scorecard. Cricket only; football never sets isNoResult here. Checked first so
  // a genuinely no-result match is always resolved, even if it's also past the absolute cap.
  if (isNoResult) return "no-result";
  // Wider absolute ceiling: applies whether or not the provider reports the match finished, so a
  // finished-but-perpetually-failing match eventually stops burning API quota.
  if (pastAbsoluteCap) return "stale";
  if (isFinished) return isFootball ? "score-football" : "score-cricket";
  if (pastStale) return "stale";
  return "skip-not-finished";
}

// Same dispatch logic as decideMatchAction, but with no staleness concept at all -- used for
// manually-targeted matches, where a human explicitly asked for this one regardless of its age.
export function decideForcedMatchAction(
  match: { cricbuzzMatchId?: string | null },
  isFinished: boolean,
  isNoResult: boolean = false
): Exclude<MatchAction, "stale" | "not-found"> {
  const isFootball = (match.cricbuzzMatchId ?? "").startsWith("espn:");
  if (isNoResult) return "no-result";
  if (isFinished) return isFootball ? "score-football" : "score-cricket";
  return "skip-not-finished";
}

interface TargetRequest {
  matchIds: string[];
  leagueCode?: string;
  series?: string;
}

// Reads job.attrs.data (as submitted via Agendash's Create Job form or the CLI wrapper) and
// determines whether this run is targeted. Returns null for the normal recurring-sweep case (no
// data, or data that specifies neither ids nor a league+series pair).
export function parseTargetRequest(data: unknown): TargetRequest | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;

  const ids = new Set<string>();
  if (typeof d.matchId === "string" && d.matchId.trim()) ids.add(d.matchId.trim());
  if (Array.isArray(d.matchIds)) {
    for (const id of d.matchIds) {
      if (typeof id === "string" && id.trim()) ids.add(id.trim());
    }
  }

  const leagueCode = typeof d.leagueCode === "string" && d.leagueCode.trim() ? d.leagueCode.trim() : undefined;
  const series = typeof d.series === "string" && d.series.trim() ? d.series.trim() : undefined;

  if (ids.size === 0 && !leagueCode && !series) return null;

  return { matchIds: [...ids], leagueCode, series };
}

interface TargetResolution {
  matches: IMatch[];
  notFound: Array<{ id: string; reason: string }>;
}

// Resolves a TargetRequest into actual Match documents, bypassing every recurring-sweep filter
// (isCompleted/noResult/date) -- a targeted run considers a match regardless of its current status.
async function resolveTargetedMatches(target: TargetRequest): Promise<TargetResolution> {
  const notFound: Array<{ id: string; reason: string }> = [];
  const matchMap = new Map<string, IMatch>();

  if (target.matchIds.length > 0) {
    const validIds = target.matchIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
    for (const id of target.matchIds) {
      if (!mongoose.Types.ObjectId.isValid(id)) notFound.push({ id, reason: "invalid match id format" });
    }
    if (validIds.length > 0) {
      const found = await Match.find({ _id: { $in: validIds } });
      const foundIds = new Set(found.map((m) => String(m._id)));
      for (const m of found) matchMap.set(String(m._id), m);
      for (const id of validIds) {
        if (!foundIds.has(id)) notFound.push({ id, reason: "no match found with this id" });
      }
    }
  }

  if (target.leagueCode || target.series) {
    if (!target.leagueCode || !target.series) {
      notFound.push({
        id: `${target.leagueCode ?? "?"}/${target.series ?? "?"}`,
        reason: "leagueCode and series must both be provided together",
      });
    } else {
      const seriesMatches = await Match.find({
        leagueCodes: target.leagueCode,
        series: target.series,
      });
      if (seriesMatches.length === 0) {
        notFound.push({
          id: `${target.leagueCode}/${target.series}`,
          reason: "no matches found for this leagueCode+series combination",
        });
      }
      for (const m of seriesMatches) matchMap.set(String(m._id), m);
    }
  }

  return { matches: [...matchMap.values()], notFound };
}

async function findCandidateMatches(): Promise<IMatch[]> {
  return Match.find({
    isCompleted: false,
    noResult: false,
    date: { $lte: new Date() },
    cricbuzzMatchId: { $exists: true, $ne: null },
  })
    .limit(50)
    .exec();
}

async function scoreCricketMatch(match: IMatch) {
  const results: Record<string, unknown> = {};
  const leagues = await LeagueCode.find({ code: { $in: match.leagueCodes } }).lean();
  const hasFantasy = leagues.some((l) => l.gameType === "fantasy11" || l.gameType === "advanced");
  const classicTargets = await resolveClassicScoringTargets(match);

  if (classicTargets.length > 0) {
    results.classic = await scoreClassicMatch(String(match._id));
  }
  if (hasFantasy) {
    results.fantasy11 = await scoreFantasy11Match(String(match._id));
  }
  return results;
}

async function scoreFootballMatchByType(match: IMatch) {
  const results: Record<string, unknown> = {};
  const leagues = await LeagueCode.find({ code: { $in: match.leagueCodes } }).lean();
  const hasFootball = leagues.some((l) => l.gameType === "football");
  const hasFootballClassic = leagues.some((l) => l.gameType === "classic" && (/football/i.test(l.code) || /football/i.test(l.name)));

  if (hasFootball) {
    results.football = await scoreFootballMatch(String(match._id));
  }
  if (hasFootballClassic) {
    results.footballClassic = await scoreFootballClassicMatchService(String(match._id));
  }
  return results;
}

export function defineCheckAndScoreJob(agenda: import("agenda").default) {
  agenda.define(JOB_NAME, async (job: Job) => {
    // Capture the submitted data before this function overwrites job.attrs.data with results below.
    const target = parseTargetRequest(job.attrs.data);
    const isTargetedRun = target !== null;

    const runSummary: Array<{ matchId: string; matchName: string; action: MatchAction; error?: string }> = [];
    let candidates: IMatch[];

    if (isTargetedRun) {
      const resolution = await resolveTargetedMatches(target!);
      candidates = resolution.matches;
      for (const nf of resolution.notFound) {
        runSummary.push({ matchId: nf.id, matchName: "(unknown)", action: "not-found", error: nf.reason });
      }
    } else {
      candidates = await findCandidateMatches();
    }

    for (const match of candidates) {
      const isFootball = (match.cricbuzzMatchId ?? "").startsWith("espn:");
      let isFinished = false;
      let isNoResult = false;

      try {
        if (isFootball) {
          const espnId = (match.cricbuzzMatchId ?? "").replace(/^espn:/, "");
          const status = await fetchEspnMatchStatus(espnId);
          isFinished = status.completed;
        } else {
          const status = await fetchCricbuzzMatchStatus(String(match.cricbuzzMatchId));
          isFinished = status.isFinished;
          isNoResult = status.isNoResult;
        }
      } catch (err) {
        runSummary.push({ matchId: String(match._id), matchName: match.matchName, action: "skip-not-finished", error: `status check failed: ${err instanceof Error ? err.message : String(err)}` });
        continue;
      }

      const action = isTargetedRun
        ? decideForcedMatchAction(match, isFinished, isNoResult)
        : decideMatchAction(match, isFinished, Date.now(), isNoResult);

      if (action === "no-result") {
        // Terminal, but no actual play happened (abandoned/cancelled/no-result/walkover). Mark the
        // match resolved exactly as a human admin would — noResult: true + isCompleted: true — and
        // never run a scorer, which would otherwise upsert bogus 0-point rows for every real team.
        await Match.findByIdAndUpdate(match._id, { noResult: true, isCompleted: true });
        runSummary.push({ matchId: String(match._id), matchName: match.matchName, action });
        continue;
      }

      if (action === "skip-not-finished" || action === "stale") {
        runSummary.push({ matchId: String(match._id), matchName: match.matchName, action });
        continue;
      }

      try {
        await Match.findByIdAndUpdate(match._id, { isCompleted: true });
        if (action === "score-cricket") {
          await scoreCricketMatch(match);
        } else {
          await scoreFootballMatchByType(match);
        }
        runSummary.push({ matchId: String(match._id), matchName: match.matchName, action });
      } catch (err) {
        // Roll isCompleted back to false so this match remains (or becomes again) a candidate
        // on the next sweep tick. Without this, a transient scoring failure permanently strands the
        // match. Safe to redo: the scoring services are idempotent (upsert-keyed by {teamId,
        // matchId} etc.), so retrying both calls next time is harmless even if one already
        // succeeded. For a targeted run this simply means the operator can just re-trigger it.
        await Match.findByIdAndUpdate(match._id, { isCompleted: false });
        runSummary.push({ matchId: String(match._id), matchName: match.matchName, action, error: err instanceof Error ? err.message : String(err) });
      }
    }

    job.attrs.data = {
      lastRunAt: new Date().toISOString(),
      mode: isTargetedRun ? "targeted" : "sweep",
      requested: isTargetedRun ? { matchIds: target!.matchIds, leagueCode: target!.leagueCode, series: target!.series } : undefined,
      candidates: candidates.length,
      results: runSummary,
    };
    await job.save();
  });
}
```

- [ ] **Step 2: Add new smoke-test cases to `scripts/smoke-job-logic.ts`**

Keep every existing assertion in the file unchanged (they cover `decideMatchAction`, still used by the recurring sweep). Add these new cases before the final `console.log("PASS: smoke-job-logic")` line — update the import line first:

```typescript
import assert from "node:assert";
import { decideMatchAction, decideForcedMatchAction, parseTargetRequest } from "../src/jobs/checkAndScoreMatches";
```

Then, before `console.log("PASS: smoke-job-logic");`, add:

```typescript
  // --- decideForcedMatchAction: no staleness concept at all, unlike decideMatchAction ---
  assert.strictEqual(
    decideForcedMatchAction({ cricbuzzMatchId: "12345" }, true, false),
    "score-cricket"
  );
  assert.strictEqual(
    decideForcedMatchAction({ cricbuzzMatchId: "espn:999" }, true, false),
    "score-football"
  );
  assert.strictEqual(
    decideForcedMatchAction({ cricbuzzMatchId: "12345" }, false, false),
    "skip-not-finished"
  );
  assert.strictEqual(
    decideForcedMatchAction({ cricbuzzMatchId: "12345" }, true, true),
    "no-result"
  );

  // --- parseTargetRequest: distinguishes a targeted request from the normal empty-data sweep ---
  assert.strictEqual(parseTargetRequest(undefined), null);
  assert.strictEqual(parseTargetRequest({}), null);
  assert.strictEqual(parseTargetRequest({ lastRunAt: "2026-01-01", candidates: 3, results: [] }), null); // looks like leftover sweep output, not a target request

  assert.deepStrictEqual(
    parseTargetRequest({ matchId: "68a1000000000000000000aa" }),
    { matchIds: ["68a1000000000000000000aa"], leagueCode: undefined, series: undefined }
  );
  assert.deepStrictEqual(
    parseTargetRequest({ matchIds: ["68a1000000000000000000aa", "68a1000000000000000000bb"] }),
    { matchIds: ["68a1000000000000000000aa", "68a1000000000000000000bb"], leagueCode: undefined, series: undefined }
  );
  // matchId and matchIds combined and deduped
  assert.deepStrictEqual(
    parseTargetRequest({ matchId: "68a1000000000000000000aa", matchIds: ["68a1000000000000000000aa", "68a1000000000000000000bb"] }),
    { matchIds: ["68a1000000000000000000aa", "68a1000000000000000000bb"], leagueCode: undefined, series: undefined }
  );
  assert.deepStrictEqual(
    parseTargetRequest({ leagueCode: "FANTASY11", series: "IPL2026" }),
    { matchIds: [], leagueCode: "FANTASY11", series: "IPL2026" }
  );
  // leagueCode alone (no series) is still a "targeted run" per parseTargetRequest -- the
  // both-required validation happens later in resolveTargetedMatches, reported as a not-found entry
  assert.deepStrictEqual(
    parseTargetRequest({ leagueCode: "FANTASY11" }),
    { matchIds: [], leagueCode: "FANTASY11", series: undefined }
  );

  console.log("PASS: smoke-job-logic");
```

- [ ] **Step 3: Run the smoke test**

```bash
npx tsx scripts/smoke-job-logic.ts
```

Expected: `PASS: smoke-job-logic`.

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 5: Manual verification against the real running service**

With the automation service running locally (`npm run dev`) and Agendash reachable, create a real one-time job via `curl` (mirroring what was already verified working during design) targeting a real match from the database:

```bash
# Find a real match id to test with (read-only query)
npx tsx -e "
import('dotenv/config').then(async () => {
  const mongoose = (await import('mongoose')).default;
  const { default: Match } = await import('./src/models/Match');
  await mongoose.connect(process.env.MONGODB_URI);
  const m = await Match.findOne({ cricbuzzMatchId: { \$exists: true, \$ne: null, \$not: /^espn:/ } }).lean();
  console.log(m._id.toString(), m.matchName, m.isCompleted);
  await mongoose.disconnect();
});
"
```

Then, using that real match id and the `AGENDASH_USER`/`AGENDASH_PASSWORD` values from `.env`:

```bash
curl -s -u "$AGENDASH_USER:$AGENDASH_PASSWORD" -X POST http://localhost:3001/admin/jobs/api/jobs/create \
  -H "Content-Type: application/json" \
  -d '{"jobName":"check-and-score-matches","jobSchedule":"now","jobData":{"matchId":"<real-id-here>"}}'
```

Wait a few seconds, then query the `agendaJobs` collection (read-only) for the newest `check-and-score-matches` job with no `repeatInterval` and confirm its `data.mode === "targeted"` and `data.requested.matchIds` contains the id you sent, with a sensible `action` in `data.results` (whatever the real match's current live status actually resolves to — `score-cricket`/`score-football`/`skip-not-finished`/`no-result`, not necessarily a specific one, since this depends on the real match's real state). Also verify the recurring sweep job (the one with `repeatInterval: "30 minutes"`) still exists unmodified — confirming the targeted run created a separate one-time document rather than interfering with it.

- [ ] **Step 6: Commit**

```bash
git add src/jobs/checkAndScoreMatches.ts scripts/smoke-job-logic.ts
git commit -m "Add targeted-run support (matchId/matchIds/leagueCode+series) to the scoring job"
```

---

### Task 2: CLI trigger wrapper

**Files:**
- Create: `scripts/trigger-scoring.ts`

**Interfaces:**
- Consumes: Agendash's `POST {baseUrl}/admin/jobs/api/jobs/create` endpoint (Task 1 makes the job actually act on the data this sends); reads the `agendaJobs` MongoDB collection directly to poll for the result.
- No other file depends on this script — it's a standalone CLI entry point.

- [ ] **Step 1: Create `scripts/trigger-scoring.ts`**

```typescript
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/db";

const JOB_NAME = "check-and-score-matches";
const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 30000;

interface ParsedArgs {
  matchId?: string;
  matchIds?: string[];
  leagueCode?: string;
  series?: string;
  url: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { url: "http://localhost:3001" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "--matchId":
        args.matchId = next();
        break;
      case "--matchIds":
        args.matchIds = next()
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case "--leagueCode":
        args.leagueCode = next();
        break;
      case "--series":
        args.series = next();
        break;
      case "--url":
        args.url = next();
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function validate(args: ParsedArgs): void {
  const hasIds = Boolean(args.matchId) || Boolean(args.matchIds?.length);
  const hasSeries = Boolean(args.leagueCode) || Boolean(args.series);
  if (hasSeries && (!args.leagueCode || !args.series)) {
    throw new Error("--leagueCode and --series must both be provided together");
  }
  if (!hasIds && !hasSeries) {
    throw new Error(
      "Provide --matchId <id>, --matchIds <id1,id2,...>, or --leagueCode <code> --series <name>"
    );
  }
}

function buildJobData(args: ParsedArgs): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (args.matchId) data.matchId = args.matchId;
  if (args.matchIds) data.matchIds = args.matchIds;
  if (args.leagueCode) data.leagueCode = args.leagueCode;
  if (args.series) data.series = args.series;
  return data;
}

async function submitJob(args: ParsedArgs): Promise<void> {
  const user = process.env.AGENDASH_USER ?? "admin";
  const password = process.env.AGENDASH_PASSWORD ?? "";
  const auth = Buffer.from(`${user}:${password}`).toString("base64");

  const res = await fetch(`${args.url}/admin/jobs/api/jobs/create`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify({
      jobName: JOB_NAME,
      jobSchedule: "now",
      jobData: buildJobData(args),
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to create job: ${res.status} ${text}`);
  }
}

interface AgendaJobDoc {
  _id: unknown;
  name: string;
  repeatInterval?: string;
  lastRunAt?: Date;
  lastFinishedAt?: Date;
  data?: unknown;
}

async function pollForResult(submittedAt: Date): Promise<AgendaJobDoc | null> {
  const db = mongoose.connection.db!;
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const job = await db
      .collection<AgendaJobDoc>("agendaJobs")
      .find({
        name: JOB_NAME,
        repeatInterval: { $exists: false },
        lastRunAt: { $gte: submittedAt },
      })
      .sort({ _id: -1 })
      .limit(1)
      .next();

    if (job?.lastFinishedAt) return job;

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  validate(args);

  const submittedAt = new Date();
  console.log(`Submitting targeted scoring job to ${args.url} ...`);
  await submitJob(args);

  await connectDB();
  console.log("Waiting for result...");
  const job = await pollForResult(submittedAt);
  await mongoose.disconnect();

  if (!job) {
    console.log(
      `Timed out after ${POLL_TIMEOUT_MS / 1000}s waiting for a result. Check Agendash at ${args.url}/admin/jobs directly.`
    );
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify(job.data, null, 2));
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Verify usage errors are caught before any network call**

```bash
npx tsx scripts/trigger-scoring.ts
```

Expected: prints `Error: Provide --matchId <id>, --matchIds <id1,id2,...>, or --leagueCode <code> --series <name>` and exits non-zero — without printing "Submitting targeted scoring job..." (proving validation runs before the request).

```bash
npx tsx scripts/trigger-scoring.ts --leagueCode FANTASY11
```

Expected: prints `Error: --leagueCode and --series must both be provided together` and exits non-zero.

- [ ] **Step 4: Manual end-to-end verification against the real running service**

With the automation service running locally (`npm run dev`), and using a real match id (same lookup approach as Task 1 Step 5):

```bash
npx tsx scripts/trigger-scoring.ts --matchId <real-id-here>
```

Expected: prints "Submitting...", "Waiting for result...", then a JSON object with `mode: "targeted"`, `requested.matchIds` containing the id, and a `results` array with one entry for that match. Confirm this matches what Task 1 Step 5's manual curl test produced for the same kind of request (same underlying job, different trigger path).

- [ ] **Step 5: Commit**

```bash
git add scripts/trigger-scoring.ts
git commit -m "Add CLI wrapper for triggering targeted scoring runs"
```

---

### Task 3: Pause/resume script for the recurring sweep

**Files:**
- Create: `scripts/toggle-sweep.ts`

**Interfaces:**
- Consumes: `connectDB` from `src/db.ts`; the `agenda` npm package directly (constructs its own `Agenda` instance, does not import anything from `src/server.ts` since that module has import-time-safety concerns already documented — see Global Constraints history in the main plan).
- No other file depends on this script.

- [ ] **Step 1: Create `scripts/toggle-sweep.ts`**

```typescript
import "dotenv/config";
import Agenda from "agenda";
import { connectDB } from "../src/db";

const JOB_NAME = "check-and-score-matches";

async function main() {
  const mode = process.argv[2];
  if (mode !== "--pause" && mode !== "--resume") {
    console.error("Usage: npx tsx scripts/toggle-sweep.ts --pause | --resume");
    process.exitCode = 1;
    return;
  }

  await connectDB();
  const agenda = new Agenda({ db: { address: process.env.MONGODB_URI! } });

  // Scoped to repeatInterval: { $exists: true } so this only ever touches the recurring sweep job,
  // never an in-flight one-time targeted run (which has no repeatInterval at all).
  const query = { name: JOB_NAME, repeatInterval: { $exists: true } };

  const affected =
    mode === "--pause" ? await agenda.disable(query) : await agenda.enable(query);

  console.log(
    `${mode === "--pause" ? "Paused" : "Resumed"} ${affected} job(s) matching "${JOB_NAME}" (recurring only).`
  );

  if (affected === 0) {
    console.log(
      "No matching recurring job found — has the automation service been started at least once (so agenda.every() has run)?"
    );
  }

  await agenda.stop().catch(() => {});
  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Manual verification against the real running service**

With the automation service running locally (its own `startAgenda()` already created the recurring job at least once):

```bash
npx tsx scripts/toggle-sweep.ts --pause
```

Expected: `Paused 1 job(s) matching "check-and-score-matches" (recurring only).`

Confirm in Agendash (`/admin/jobs`) or via a direct query that the recurring job document now has `disabled: true`, and that its `nextRunAt` tick does NOT fire while paused (wait past what would have been its next run time, or just trust Agenda's own `find-and-lock-next-job` query which excludes `disabled: true` — verified during design).

```bash
npx tsx scripts/toggle-sweep.ts --resume
```

Expected: `Resumed 1 job(s) matching "check-and-score-matches" (recurring only).` Confirm `disabled` is back to `false` and the job resumes ticking on schedule.

- [ ] **Step 4: Commit**

```bash
git add scripts/toggle-sweep.ts
git commit -m "Add pause/resume script for the recurring scoring sweep"
```

---

## Self-Review Notes (from plan authoring)

- **Spec coverage:** targeted trigger via Agendash (Task 1), CLI wrapper (Task 2), pause/resume (Task 3) — every piece of the design doc has a corresponding task.
- **Type consistency check:** `decideForcedMatchAction`'s return type (`Exclude<MatchAction, "stale" | "not-found">`) matches how it's actually used in the job handler (only ever assigned to `action` alongside `decideMatchAction`'s broader type — both narrow to the same handled cases in the `if` chain). `parseTargetRequest`'s return shape matches what `resolveTargetedMatches` (Task 1) and the smoke test (Task 1 Step 2) both expect.
- **Cross-task dependency:** Task 2 and Task 3 both depend on Task 1 being complete and correct (Task 2 needs the job to actually read `matchId`/`matchIds`/`leagueCode`+`series` from its data; Task 3 needs the recurring job to already exist in MongoDB, which only happens after the service has been started at least once with Task 1's code deployed) — execute in order, 1 then 2 and 3 (2/3 can run in either order relative to each other, both only depend on 1).
