// Verified live during design (2026-08-06) against real match ids:
//   150993 (Ireland vs Afghanistan, 1st ODI) -> state="Abandon"  (terminal, match over)
//   151004 (Ireland vs Afghanistan, 2nd ODI) -> state="Preview"  (not started)
// Cricbuzz's `state` field is a small fixed enum. We only need to recognise the terminal
// values confidently; anything unrecognised is treated as "not finished yet" so an unmapped
// future state just delays scoring one more poll cycle instead of risking a wrong call.
const TERMINAL_STATES = new Set([
  "complete",
  "completed",
  "abandon",
  "abandoned",
  "cancelled",
  "canceled",
  "no result",
  "walkover",
]);

export interface CricbuzzMatchStatus {
  state: string;
  status: string;
  isFinished: boolean;
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
  return {
    state,
    status: String(data.status ?? ""),
    isFinished: TERMINAL_STATES.has(state.trim().toLowerCase()),
  };
}
