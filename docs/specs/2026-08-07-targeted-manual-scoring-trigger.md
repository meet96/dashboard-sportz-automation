# Targeted Manual Scoring Trigger via Agendash — Design

**Date:** 2026-08-07
**Status:** Approved, not yet implemented

## Problem

The `check-and-score-matches` Agenda job automatically sweeps all pending matches every 30 minutes. There's no way to force scoring for one specific match (or a small set) on demand — e.g. to test a scoring-rule change, re-score after fixing a bug, or nudge a match the automatic sweep skipped for some reason — without waiting for the next sweep, and the sweep's guardrails (`isCompleted: false`, staleness caps) would skip an already-scored or old match anyway.

Goal: let an operator trigger scoring for specific match ID(s) directly from the Agendash UI, with the job picking up those IDs and acting on them in the background — no separate endpoint, no code deploy per use.

## Approach

Reuse the existing `check-and-score-matches` job definition rather than adding a second job type. Agendash's "Create Job" form lets an operator submit arbitrary JSON as the job's `data` when creating a one-time job under an existing name. The job handler branches on whether that data contains match IDs:

- **Recurring sweep** (data empty/absent — the normal 30-minute schedule): unchanged. Same candidate query (`isCompleted: false`, `noResult: false`, `date` in the past), same 12h/48h staleness caps.
- **Targeted run** (data contains `{"matchId": "<id>"}` or `{"matchIds": ["<id>", ...]}`, created via Agendash's "Create Job" form with a one-time schedule): loads exactly those match(es) by `_id`, bypassing the `isCompleted`/`noResult`/`date` filters and both staleness caps entirely — a human explicitly asked for this one, so the guardrails that exist to bound the *unattended* sweep don't apply. It still calls the real live Cricbuzz/ESPN status check (can't score a match that hasn't actually finished) and then scores or marks no-result exactly like the normal path, including re-scoring an already-scored match (matching how the admin UI's existing "force" button already works).

One job definition handles both because the actual dispatch logic (status-check → score-or-no-result) is identical either way; only *which matches to consider* and *which guardrails apply* differ.

## Behavior details

- **Input normalization:** accepts either `matchId` (single string) or `matchIds` (string array) in job data; both may be present, results are deduped.
- **Invalid/not-found IDs:** malformed ObjectId strings and IDs that don't resolve to a real match are both reported in the job's result summary (a new `"not-found"` action) rather than silently dropped — so the operator gets feedback from Agendash's UI about typos.
- **No staleness applied:** a targeted run uses a simpler decision (`isNoResult` → mark no-result and skip; `isFinished` → score; not finished → `skip-not-finished`) with no 12h/48h cap check — an old match is exactly the kind of thing an operator would manually force.
- **Not finished yet:** if the provider still reports the match live/upcoming, the targeted run reports `skip-not-finished` rather than scoring garbage — forcing doesn't fabricate a result that doesn't exist yet.
- **Result visibility:** the job's `data` after a targeted run includes a `mode: "targeted"` marker and the originally-requested IDs, alongside the same `results` summary shape the sweep already produces, so Agendash's job-detail view shows what happened per requested match.

## Out of scope

- No new HTTP endpoint — Agendash's existing "Create Job" UI is the only trigger surface, per what was asked.
- No change to the recurring sweep's guardrails or schedule.
- No UI changes to Agendash itself (it's a third-party package) — the operator types raw JSON into its existing generic "Create Job" form.
