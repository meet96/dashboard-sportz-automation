# Manual Scoring Controls (Targeted Trigger, CLI, Pause/Resume) — Design

**Date:** 2026-08-07
**Status:** Approved, not yet implemented

## Problem

The `check-and-score-matches` Agenda job automatically sweeps all pending matches every 30 minutes. There's no way to force scoring for a specific match, a handful of matches, or a whole series on demand — e.g. to test a scoring-rule change, re-score after fixing a bug, or catch up a series the automatic sweep skipped for some reason — without waiting for the next sweep, and the sweep's guardrails (`isCompleted: false`, staleness caps) would skip already-scored or old matches anyway.

Goal:
1. Keep the existing recurring job — runs every 30 minutes, checks and scores whatever's pending. (Already built.)
2. Add the ability to trigger scoring **on demand**, from Agendash, for a specific match, a few matches, or an entire series — with the job picking up the request and acting on it in the background. No separate endpoint, no code deploy per use.
3. Add a CLI convenience wrapper so triggering doesn't require opening the browser and hand-typing JSON each time — pass a match ID (or a few, or a league+series) as command-line arguments instead.
4. Add the ability to temporarily pause and later resume the recurring sweep itself — useful e.g. while debugging, during a known provider outage, or ahead of a maintenance window.

## Approach

Reuse the existing `check-and-score-matches` job definition rather than adding a second job type. Agendash's "Create Job" form lets an operator submit arbitrary JSON as the job's `data` when creating a one-time job under an existing name. The job handler branches on whether that data specifies a target:

- **Recurring sweep** (data empty/absent — the normal 30-minute schedule): unchanged. Same candidate query (`isCompleted: false`, `noResult: false`, `date` in the past), same 12h/48h staleness caps.
- **Targeted run** (data specifies matches or a series, created via Agendash's "Create Job" form with a one-time schedule): resolves to a concrete set of match `_id`s (see Targeting modes below), bypassing the `isCompleted`/`noResult`/`date` filters and both staleness caps entirely — a human explicitly asked for these, so the guardrails that exist to bound the *unattended* sweep don't apply. It still calls the real live Cricbuzz/ESPN status check for each (can't score a match that hasn't actually finished) and then scores or marks no-result exactly like the normal path, including re-scoring an already-scored match (matching how the admin UI's existing "force" button already works).

One job definition handles both because the actual dispatch logic (status-check → score-or-no-result) is identical either way; only *which matches to consider* and *which guardrails apply* differ.

## Targeting modes (job data)

All three may be combined in one request; the resulting match ID sets are unioned and deduped.

- **Single match:** `{"matchId": "<id>"}`
- **Multiple matches:** `{"matchIds": ["<id>", "<id>", ...]}`
- **Whole series:** `{"leagueCode": "FANTASY11", "series": "IPL2026"}` — both fields required together (a series name alone is ambiguous: two leagues have shared a series name before, after a leagueCode merge — see project history). Resolves to every `Match` whose `leagueCodes` array contains that leagueCode AND whose `series` array contains that series name. Providing only one of `leagueCode`/`series` is treated as invalid input and reported as an error, not silently ignored or run unscoped.

## Behavior details

- **Invalid/not-found IDs:** malformed ObjectId strings and IDs that don't resolve to a real match are both reported in the job's result summary (a new `"not-found"` action) rather than silently dropped — so the operator gets feedback from Agendash's UI about typos.
- **Series with no matches / invalid leagueCode+series combo:** reported as an explicit error in the result (not a silent no-op), so a typo'd series name is visible.
- **No staleness applied:** a targeted run uses a simpler decision (`isNoResult` → mark no-result and skip; `isFinished` → score; not finished → `skip-not-finished`) with no 12h/48h cap check — an old match is exactly the kind of thing an operator would manually force.
- **Not finished yet:** if the provider still reports a targeted match live/upcoming, the run reports `skip-not-finished` for it rather than scoring garbage — forcing doesn't fabricate a result that doesn't exist yet. Other matches in the same targeted batch are unaffected.
- **Result visibility:** the job's `data` after a targeted run includes a `mode: "targeted"` marker and what was requested (ids and/or leagueCode+series), alongside the same `results` summary shape the sweep already produces, so Agendash's job-detail view shows what happened per requested match.

## CLI wrapper (`scripts/trigger-scoring.ts`)

A small script that automates exactly what a human would do in Agendash's "Create Job" form — no new backend endpoint, it calls the *same* Agendash create-job API (`POST /admin/jobs/api/jobs/create`, basic-auth via `AGENDASH_USER`/`AGENDASH_PASSWORD` already in `.env`) that the UI form itself calls, verified working earlier in this design process.

**Usage:**
```bash
npx tsx scripts/trigger-scoring.ts --matchId <id>
npx tsx scripts/trigger-scoring.ts --matchIds <id1>,<id2>,<id3>
npx tsx scripts/trigger-scoring.ts --leagueCode FANTASY11 --series IPL2026
npx tsx scripts/trigger-scoring.ts --url https://<railway-url> --matchId <id>   # against a deployed instance instead of localhost
```

Validation mirrors the job handler's own: at least one of `--matchId`/`--matchIds` must be given, or both `--leagueCode` and `--series` together (one without the other is a usage error, caught before any request is sent). `--url` defaults to `http://localhost:3001`.

**Behavior:** posts the create-job request with `jobSchedule: "now"` (no `jobRepeatEvery`, so it's always a one-time run, never a duplicate recurring job) and the resolved `jobData`. Then polls the `agendaJobs` collection directly (the script already needs `MONGODB_URI` from `.env`, same as every other script in this repo) for the newest one-time job named `check-and-score-matches` (`repeatInterval` absent, distinguishing it from the recurring sweep) created after the request was sent, until it has a `lastFinishedAt`, and prints its result (`data.results`) to the terminal — so the operator sees the outcome (scored / no-result / skip-not-finished / not-found / error) without switching to the browser. Polls roughly once per second for up to 30 seconds; if it times out without finding a finished job, it says so and points at Agendash instead of hanging forever.

## Pause/resume the recurring sweep (`scripts/toggle-sweep.ts`)

Agendash's UI has no enable/disable action (checked its full source — only view, requeue, delete, create exist). The underlying `agenda` library does support this independently of Agendash: `agenda.disable(query)` / `agenda.enable(query)` set a `disabled: true/false` flag on matching job documents, and Agenda's own job-locking query (`find-and-lock-next-job.js:38`, `disabled: { $ne: true }`) genuinely excludes disabled jobs from being picked up — verified by reading the installed package, not assumed.

This script talks to MongoDB/Agenda directly (like the repo's other maintenance scripts), not through Agendash's HTTP API — there's no HTTP surface for this action to call.

**Usage:**
```bash
npx tsx scripts/toggle-sweep.ts --pause
npx tsx scripts/toggle-sweep.ts --resume
```

**Behavior:** connects via `MONGODB_URI`, disables/enables jobs matching `{ name: "check-and-score-matches", repeatInterval: { $exists: true } }` — deliberately scoped to the recurring job only (via the `repeatInterval` field, which only recurring jobs have) so it never touches an in-flight one-time targeted run. Prints the number of jobs affected and the resulting `disabled` state for confirmation. Pausing does not cancel a run already in progress, only prevents the *next* scheduled tick from firing.

## Out of scope

- No new HTTP endpoint on the automation service itself — the browser UI and the CLI trigger wrapper go through Agendash's existing create-job API; the pause/resume script talks to Agenda/MongoDB directly since Agendash has no HTTP surface for that action.
- No change to the recurring sweep's schedule/interval itself (still 30 minutes when active) — only whether it runs at all.
- No UI changes to Agendash itself (it's a third-party package).
