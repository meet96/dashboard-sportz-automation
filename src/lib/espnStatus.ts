// Verified live during design (2026-08-06) against real match id 401879301
// (Arsenal vs Coventry City, not yet played): status.type = { state: "pre", completed: false }.
// ESPN's `completed` boolean is the authoritative "this game is over" signal — no state-string
// guessing needed, unlike Cricbuzz. Its `state` field cleanly distinguishes "pre" (not started),
// "in" (live), "post" (finished) -- isLive is a direct equality check, no allowlist needed.
export interface EspnMatchStatus {
  state: string;
  completed: boolean;
  isLive: boolean;
}

export async function fetchEspnMatchStatus(eventId: string): Promise<EspnMatchStatus> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/all/summary?event=${encodeURIComponent(eventId)}`;
  const res = await fetch(url, { cache: "no-store" as RequestCache });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ESPN status API error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as {
    header?: { competitions?: Array<{ status?: { type?: { state?: string; completed?: boolean } } }> };
  };
  const type = data.header?.competitions?.[0]?.status?.type;
  if (!type) throw new Error("ESPN response missing header.competitions[0].status.type");

  const state = String(type.state ?? "");
  return {
    state,
    completed: type.completed === true,
    isLive: state === "in",
  };
}
