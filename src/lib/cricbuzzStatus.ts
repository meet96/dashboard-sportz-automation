// Verified live during design (2026-08-06) against real match ids:
//   150993 (Ireland vs Afghanistan, 1st ODI) -> state="Abandon"  (terminal, match over)
//   151004 (Ireland vs Afghanistan, 2nd ODI) -> state="Preview"  (not started)
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

export interface CricbuzzMatchStatus {
  state: string;
  status: string;
  isFinished: boolean;
  // True only for the no-play terminal subset (abandoned/cancelled/no result/walkover). isFinished
  // is true for these too — the match IS over — but they must be resolved as no-result, not scored.
  isNoResult: boolean;
}

export async function fetchCricbuzzMatchStatus(matchId: string): Promise<CricbuzzMatchStatus> {
  const apiKey = process.env.CRICBUZZ_API_KEY;
  if (!apiKey) throw new Error("CRICBUZZ_API_KEY is not configured");
  const host = process.env.CRICBUZZ_API_HOST ?? "cricbuzz-cricket.p.rapidapi.com";

  const url = `https://${host}/mcenter/v1/${encodeURIComponent(matchId)}`;
  const res = await fetch(url, {
    headers: { "X-RapidAPI-Key": apiKey, "X-RapidAPI-Host": host },
    cache: "no-store" as RequestCache,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Cricbuzz status API error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as { state?: string; status?: string };
  const state = String(data.state ?? "");
  const normalized = state.trim().toLowerCase();
  return {
    state,
    status: String(data.status ?? ""),
    isFinished: TERMINAL_STATES.has(normalized),
    isNoResult: NO_RESULT_STATES.has(normalized),
  };
}
