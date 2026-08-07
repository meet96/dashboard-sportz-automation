# Targeted Manual Scoring Trigger via Agendash — Design

**Date:** 2026-08-07
**Status:** Approved, not yet implemented

## Problem

The `check-and-score-matches` Agenda job automatically sweeps all pending matches every 30 minutes. There's no way to force scoring for a specific match, a handful of matches, or a whole series on demand — e.g. to test a scoring-rule change, re-score after fixing a bug, or catch up a series the automatic sweep skipped for some reason — without waiting for the next sweep, and the sweep's guardrails (`isCompleted: false`, staleness caps) would skip already-scored or old matches anyway.

Goal:
1. Keep the existing recurring job — runs every 30 minutes, checks and scores whatever's pending. (Already built.)
2. Add the ability to trigger scoring **on demand**, from Agendash, for a specific match, a few matches, or an entire series — with the job picking up the request and acting on it in the background. No separate endpoint, no code deploy per use.

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

## Out of scope

- No new HTTP endpoint — Agendash's existing "Create Job" UI is the only trigger surface, per what was asked.
- No change to the recurring sweep's guardrails or schedule.
- No UI changes to Agendash itself (it's a third-party package) — the operator types raw JSON into its existing generic "Create Job" form.
