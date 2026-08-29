// Verified live during design (2026-08-06) against real match id 401879301
// (Arsenal vs Coventry City, not yet played): status.type = { state: "pre", completed: false }.
// ESPN's `completed` boolean is the authoritative "this game is over" signal — no state-string
// guessing needed, unlike Cricbuzz. Its `state` field cleanly distinguishes "pre" (not started),
// "in" (live), "post" (finished) -- isLive is a direct equality check, no allowlist needed.
export interface EspnMatchStatus {
  state: string;
  completed: boolean;
  isLive: boolean;
  // Human-readable scoreline e.g. "Man City 2-1 Crystal Palace", or null if the same response
  // didn't carry two competitors with parseable scores (shouldn't happen in practice, but the
  // score is a display-only extra -- never worth failing the whole status check over).
  score: string | null;
}

export async function fetchEspnMatchStatus(eventId: string): Promise<EspnMatchStatus> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/all/summary?event=${encodeURIComponent(eventId)}`;
  const res = await fetch(url, { cache: "no-store" as RequestCache });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ESPN status API error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as {
    header?: {
      competitions?: Array<{
        status?: { type?: { state?: string; completed?: boolean } };
        competitors?: Array<{ homeAway?: string; score?: string; team?: { displayName?: string; shortDisplayName?: string; abbreviation?: string } }>;
      }>;
    };
  };
  const competition = data.header?.competitions?.[0];
  const type = competition?.status?.type;
  if (!type) throw new Error("ESPN response missing header.competitions[0].status.type");

  const state = String(type.state ?? "");
  const home = competition?.competitors?.find((c) => c.homeAway === "home");
  const away = competition?.competitors?.find((c) => c.homeAway === "away");
  // abbreviation is ESPN's own short code (e.g. "MCI", "CRY") -- the same thing ESPN's UI shows,
  // and what we want here over a full team name.
  const teamLabel = (c: typeof home) => c?.team?.abbreviation ?? c?.team?.shortDisplayName ?? c?.team?.displayName ?? "";
  const score =
    home?.score !== undefined && away?.score !== undefined
      ? `${teamLabel(home)} ${home.score}-${away.score} ${teamLabel(away)}`.trim()
      : null;

  return {
    state,
    completed: type.completed === true,
    isLive: state === "in",
    score,
  };
}
