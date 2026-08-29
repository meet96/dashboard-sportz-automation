// Verified live during design (2026-08-06) against real match id 401879301
// (Arsenal vs Coventry City, not yet played): status.type = { state: "pre", completed: false }.
// ESPN's `completed` boolean is the authoritative "this game is over" signal — no state-string
// guessing needed, unlike Cricbuzz. Its `state` field cleanly distinguishes "pre" (not started),
// "in" (live), "post" (finished) -- isLive is a direct equality check, no allowlist needed.
export interface EspnMatchStatus {
  state: string;
  completed: boolean;
  isLive: boolean;
  // Structured scoreline for the two competitors, or null if the response didn't carry two
  // parseable competitors (shouldn't happen in practice, but this is a display-only extra --
  // never worth failing the whole status check over).
  score: EspnLiveScore | null;
}

export interface EspnTeamScore {
  // ESPN's own short code (e.g. "MCI", "CRY") -- the same thing ESPN's UI shows, and what we want
  // over a full team name.
  code: string;
  score: string;
  // Crest URL, or null if ESPN didn't include one for this team.
  logo: string | null;
}

export interface EspnLiveScore {
  home: EspnTeamScore;
  away: EspnTeamScore;
}

interface EspnCompetitor {
  homeAway?: string;
  score?: string;
  team?: {
    displayName?: string;
    shortDisplayName?: string;
    abbreviation?: string;
    logo?: string;
    logos?: Array<{ href?: string }>;
  };
}

function toTeamScore(c: EspnCompetitor | undefined): EspnTeamScore | null {
  if (!c || c.score === undefined) return null;
  const code = c.team?.abbreviation ?? c.team?.shortDisplayName ?? c.team?.displayName ?? "";
  const logo = c.team?.logo ?? c.team?.logos?.[0]?.href ?? null;
  return { code, score: c.score, logo };
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
        competitors?: EspnCompetitor[];
      }>;
    };
  };
  const competition = data.header?.competitions?.[0];
  const type = competition?.status?.type;
  if (!type) throw new Error("ESPN response missing header.competitions[0].status.type");

  const state = String(type.state ?? "");
  const home = toTeamScore(competition?.competitors?.find((c) => c.homeAway === "home"));
  const away = toTeamScore(competition?.competitors?.find((c) => c.homeAway === "away"));

  return {
    state,
    completed: type.completed === true,
    isLive: state === "in",
    score: home && away ? { home, away } : null,
  };
}
