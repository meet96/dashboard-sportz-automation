import { fetchCricbuzz } from "./cricbuzzClient";

// Verified live during design (2026-08-06) against real match ids:
//   150993 (Ireland vs Afghanistan, 1st ODI) -> state="Abandon"  (terminal, match over)
//   151004 (Ireland vs Afghanistan, 2nd ODI) -> state="Preview"  (not started), later "In Progress" (live, real data)
// Cricbuzz's `state` field is a small fixed enum. We only need to recognise the terminal
// values confidently; anything unrecognised is treated as "not finished yet" so an unmapped
// future state just delays scoring one more poll cycle instead of risking a wrong call.
// Genuinely-complete: real play happened and the result is ready to score.
const COMPLETE_STATES = new Set([
  "complete",
  "completed",
]);
// Terminal but no actual play / no scorecard to score — must NOT be handed to a scorer (it would
// upsert 0 points to every team). These are routed to Match.noResult: true instead.
const NO_RESULT_STATES = new Set([
  "abandon",
  "abandoned",
  "cancelled",
  "canceled",
  "no result",
  "walkover",
]);
// A match is "finished" (no more status polling needed) if it's in either terminal group.
const TERMINAL_STATES = new Set([...COMPLETE_STATES, ...NO_RESULT_STATES]);
// Not yet started -- no real player data exists yet, so there's nothing to live-score. Verified
// live: "Preview" is the pre-toss state, "Upcoming" is also used by Cricbuzz for not-yet-started
// fixtures (found via real API data during implementation -- three real scheduled matches
// returned state="Upcoming", not "Preview"). "Toss" (post-toss, pre-first-ball) is included
// conservatively for the same reason -- no batting/bowling data exists until the first ball is
// bowled.
const NOT_STARTED_STATES = new Set([
  "preview",
  "upcoming",
  "toss",
]);

export interface CricbuzzMatchStatus {
  state: string;
  status: string;
  isFinished: boolean;
  // True only for the no-play terminal subset (abandoned/cancelled/no result/walkover). isFinished
  // is true for these too — the match IS over — but they must be resolved as no-result, not scored.
  isNoResult: boolean;
  // True when the match has genuinely started and has real partial data worth live-scoring --
  // i.e. not terminal (isFinished) and not in the "hasn't started yet" set. Conservative default:
  // an unrecognized state is NOT live, matching this file's existing safe-default philosophy.
  isLive: boolean;
}

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
