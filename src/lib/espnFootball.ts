export interface EspnFootballPlayerStat {
  name: string;
  position: string;
  teamId: string;
  goals: number;
  assists: number;
  yellowCards: number;
  redCards: number;
  cleanSheet: boolean;
}

export interface EspnFootballParsedData {
  eventId: string;
  homeTeam: { id: string; name: string; score: number };
  awayTeam: { id: string; name: string; score: number };
  playerStats: Map<string, EspnFootballPlayerStat>;
}

function normalizeName(name: string): string {
  return String(name ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[.'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseEventId(ref: string): string | null {
  const input = String(ref ?? "").trim();
  if (!input) return null;

  // ESPN URL example: .../match/_/gameId/401862897
  const gameIdMatch = input.match(/(?:gameId[=\/]|event=)(\d{6,})/i);
  if (gameIdMatch?.[1]) return gameIdMatch[1];

  // Raw numeric id
  if (/^\d{6,}$/.test(input)) return input;

  // Fallback: first long digit sequence
  const anyDigits = input.match(/(\d{6,})/);
  return anyDigits?.[1] ?? null;
}

function isDefenderPosition(pos: string): boolean {
  const p = String(pos ?? "").toUpperCase();
  return p === "D" || p.startsWith("CD") || p === "CB" || p === "LB" || p === "RB" || p === "LWB" || p === "RWB" || p === "SW";
}

function isGoalkeeperPosition(pos: string): boolean {
  const p = String(pos ?? "").toUpperCase();
  return p === "G" || p === "GK";
}

export function isGoalkeeperOrDefender(pos: string): boolean {
  return isGoalkeeperPosition(pos) || isDefenderPosition(pos);
}

function upsertPlayer(
  map: Map<string, EspnFootballPlayerStat>,
  name: string,
  position: string,
  teamId: string
): EspnFootballPlayerStat {
  const key = normalizeName(name);
  const existing = map.get(key);
  if (existing) return existing;

  const next: EspnFootballPlayerStat = {
    name,
    position,
    teamId,
    goals: 0,
    assists: 0,
    yellowCards: 0,
    redCards: 0,
    cleanSheet: false,
  };
  map.set(key, next);
  return next;
}

function parseCardedPlayer(text: string): string | null {
  const t = String(text ?? "").trim();
  if (!t) return null;

  // Examples:
  // "Bukayo Saka (Arsenal) is shown the yellow card ..."
  // "Nick Moon (Athletic Club Boise) Red Card at 45'+1'"
  const m = t.match(/^([^()]+?)\s*\(/);
  return m?.[1]?.trim() ?? null;
}

function parseGoalScorerAndAssist(text: string): { scorer?: string; assist?: string } {
  const t = String(text ?? "").trim();
  if (!t) return {};

  if (/own goal/i.test(t)) return {};

  // Typical ESPN text:
  // Goal! TeamA 1, TeamB 0. Kai Havertz (Arsenal) ... Assisted by Leandro Trossard.
  const scorerMatch = t.match(/\.\s*([^.(]+?)\s*\(/);
  const assistMatch = t.match(/Assisted by\s+(.+?)(?:\s+with\b|\s+following\b|[.,;]|$)/i);

  return {
    scorer: scorerMatch?.[1]?.trim(),
    assist: assistMatch?.[1]?.trim(),
  };
}

export async function fetchAndParseEspnFootballMatch(eventRef: string): Promise<EspnFootballParsedData> {
  const eventId = parseEventId(eventRef);
  if (!eventId) {
    throw new Error("Invalid ESPN event id/reference. Provide a numeric event id or ESPN match URL.");
  }

  const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/all/summary?event=${eventId}`;
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
      accept: "application/json,text/plain,*/*",
    },
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ESPN summary failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const data: any = await res.json();

  const competitors = data?.header?.competitions?.[0]?.competitors;
  if (!Array.isArray(competitors) || competitors.length < 2) {
    throw new Error("ESPN summary missing competitor data");
  }

  const home = competitors.find((c: any) => c.homeAway === "home") ?? competitors[0];
  const away = competitors.find((c: any) => c.homeAway === "away") ?? competitors[1];

  const homeTeam = {
    id: String(home?.id ?? home?.team?.id ?? "home"),
    name: String(home?.team?.displayName ?? home?.displayName ?? "Home"),
    score: Number(home?.score ?? 0),
  };

  const awayTeam = {
    id: String(away?.id ?? away?.team?.id ?? "away"),
    name: String(away?.team?.displayName ?? away?.displayName ?? "Away"),
    score: Number(away?.score ?? 0),
  };

  const playerStats = new Map<string, EspnFootballPlayerStat>();

  // Build player map from rosters (starters and subs).
  for (const roster of Array.isArray(data?.rosters) ? data.rosters : []) {
    const teamId = String(roster?.team?.id ?? "");
    const players = Array.isArray(roster?.roster) ? roster.roster : [];

    for (const p of players) {
      const name = String(p?.athlete?.displayName ?? "").trim();
      if (!name) continue;

      const pos = String(p?.position?.abbreviation ?? p?.position?.name ?? p?.athlete?.position?.abbreviation ?? "").trim();
      upsertPlayer(playerStats, name, pos, teamId);
    }
  }

  // Parse goals and assists from keyEvents.
  for (const ev of Array.isArray(data?.keyEvents) ? data.keyEvents : []) {
    const typeText = String(ev?.type?.text ?? ev?.type?.name ?? "");
    const isGoalEvent = /goal/i.test(typeText) || /penalty\s*-\s*scored/i.test(typeText);
    if (!isGoalEvent) continue;

    const parsed = parseGoalScorerAndAssist(String(ev?.text ?? ""));
    if (parsed.scorer) {
      const teamName = String(ev?.team?.displayName ?? "").toLowerCase();
      const teamId = teamName && teamName.includes(homeTeam.name.toLowerCase())
        ? homeTeam.id
        : teamName && teamName.includes(awayTeam.name.toLowerCase())
          ? awayTeam.id
          : String(ev?.team?.id ?? "");
      const scorer = upsertPlayer(playerStats, parsed.scorer, "", teamId);
      scorer.goals += 1;
    }

    if (parsed.assist) {
      const assister = upsertPlayer(playerStats, parsed.assist, "", String(ev?.team?.id ?? ""));
      assister.assists += 1;
    }
  }

  // Parse yellow/red cards from keyEvents.
  for (const ev of Array.isArray(data?.keyEvents) ? data.keyEvents : []) {
    const typeText = String(ev?.type?.text ?? ev?.type?.name ?? "").toLowerCase();
    const eventText = String(ev?.text ?? "").toLowerCase();

    const hasYellow = typeText.includes("yellow card") || eventText.includes("yellow card");
    const hasRed = typeText.includes("red card") || eventText.includes("red card");
    if (!hasYellow && !hasRed) continue;

    const rawName = parseCardedPlayer(String(ev?.text ?? ""));
    if (!rawName) continue;

    const player = upsertPlayer(
      playerStats,
      rawName,
      "",
      String(ev?.team?.id ?? "")
    );

    // If event says second yellow and red, count only red to avoid double penalty.
    const secondYellow = eventText.includes("second yellow");
    if (hasRed || secondYellow) {
      player.redCards += 1;
      continue;
    }
    if (hasYellow) {
      player.yellowCards += 1;
    }
  }

  // Assign clean sheets to GK and defenders of team that conceded zero.
  const homeConceded = awayTeam.score;
  const awayConceded = homeTeam.score;

  for (const p of playerStats.values()) {
    if (!isGoalkeeperOrDefender(p.position)) continue;

    if (p.teamId === homeTeam.id && homeConceded === 0) p.cleanSheet = true;
    if (p.teamId === awayTeam.id && awayConceded === 0) p.cleanSheet = true;
  }

  return {
    eventId,
    homeTeam,
    awayTeam,
    playerStats,
  };
}

export function normalizeFootballName(name: string): string {
  return normalizeName(name);
}
