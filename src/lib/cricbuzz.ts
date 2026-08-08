/**
 * lib/cricbuzz.ts
 *
 * Cricbuzz (RapidAPI) scorecard fetcher + parser.
 *
 * Scoring weights are configurable per league via the ScoringConfig model.
 * Default weights: 1 pt/run, 5 pts/wicket, 2 pts/catch, 3 pts/stumping.
 *
 * Environment variables required for API calls:
 *   CRICBUZZ_API_KEYS  — comma-separated RapidAPI keys (round-robined; see cricbuzzClient.ts)
 *   CRICBUZZ_API_HOST  — optional, defaults to "cricbuzz-cricket.p.rapidapi.com"
 */

import { fetchCricbuzz } from "./cricbuzzClient";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlayerStats {
  runs: number;
  fours: number;
  sixes: number;
  wickets: number;
  catches: number;
  runOuts: number;
  stumpings: number;
}

/** A map from normalised player name → stats */
export type PlayerStatsMap = Map<string, PlayerStats>;

export interface ScoringWeights {
  teamSize: number;
  bonusMultiplier: number;
  momMultiplier: number;
  pointsPerRun: number;
  pointsPerFour: number;
  pointsPerSix: number;
  fiftyBonus: number;
  centuryBonus: number;
  catchPoints: number;
  runOutPoints: number;
  wicketPoints: number;
  threeWicketBonus: number;
  fiveWicketBonus: number;
  stumpingPoints: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  teamSize: 8,
  bonusMultiplier: 1,
  momMultiplier: 1,
  pointsPerRun: 1,
  pointsPerFour: 2,
  pointsPerSix: 5,
  fiftyBonus: 25,
  centuryBonus: 50,
  catchPoints: 10,
  runOutPoints: 10,
  wicketPoints: 25,
  threeWicketBonus: 25,
  fiveWicketBonus: 50,
  stumpingPoints: 10,
};

export interface PlayerPointBreakdown {
  playerName: string;
  runs: number;
  fours: number;
  sixes: number;
  wickets: number;
  catches: number;
  runOuts: number;
  stumpings: number;
  points: number;
}

// ---------------------------------------------------------------------------
// Name normalisation & matching
// ---------------------------------------------------------------------------

/** Lowercase, strip non-alpha-space chars (†, *, etc.), collapse whitespace */
function normaliseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[†*()']/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parts(normalised: string): string[] {
  return normalised.split(" ").filter(Boolean);
}

function lastName(p: string[]): string {
  return p[p.length - 1];
}

/**
 * Score how well a team player name matches a scorecard name.
 *
 * Strategy (highest wins):
 *  100 — exact normalised match
 *   90 — all parts of the shorter name found in the longer (subset match)
 *   85 — same surname + first part is initial of first word (v → virat)
 *   80 — same surname + both have multi-char firsts that match each other's start
 *    0 — no confident match
 */
function nameMatchScore(teamName: string, scorecardName: string): number {
  const t = normaliseName(teamName);
  const s = normaliseName(scorecardName);

  if (t === s) return 100;

  const tParts = parts(t);
  const sParts = parts(s);

  const tLast = lastName(tParts);
  const sLast = lastName(sParts);

  // Surnames must match
  if (tLast !== sLast) return 0;

  // Single-word name (e.g. just "Bumrah") — only match exact
  if (tParts.length === 1 || sParts.length === 1) {
    // If one side is a single word (the surname) and it matched, not enough confidence
    return 0;
  }

  // Subset: every token in shorter name found in longer name
  // e.g. "kl rahul" ↔ "k l rahul" edge case — handled by below too
  const shorter = tParts.length <= sParts.length ? tParts : sParts;
  const longer  = tParts.length <= sParts.length ? sParts : tParts;
  if (shorter.every((tok) => longer.includes(tok))) return 90;

  const tFirst = tParts[0];
  const sFirst = sParts[0];

  // Initial match: single char "v" matches "virat", or "v" in "virat kohli"
  if (tFirst.length === 1 && sFirst.startsWith(tFirst)) return 85;
  if (sFirst.length === 1 && tFirst.startsWith(sFirst)) return 85;

  // Multi-initial like "kl" matches "kl rahul" — already handled by subset above
  // or "kl" matches "kieron liam" — both start with same chars
  if (tFirst.startsWith(sFirst) || sFirst.startsWith(tFirst)) return 80;

  // Surname-only match is NOT enough — too many false positives (e.g. "Sharma", "Singh")
  return 0;
}

/**
 * Find stats for a team player from the scorecard stats map.
 * Returns null if no confident match found (score < 70).
 */
export function findPlayerInMap(
  teamPlayerName: string,
  statsMap: PlayerStatsMap
): PlayerStats | null {
  let bestScore = 0;
  let bestStats: PlayerStats | null = null;

  for (const [key, stats] of statsMap) {
    const score = nameMatchScore(teamPlayerName, key);
    if (score > bestScore) {
      bestScore = score;
      bestStats = stats;
    }
  }

  return bestScore >= 80 ? bestStats : null;
}

/**
 * Like findPlayerInMap but also returns the matched scorecard name and score.
 * Useful for debugging.
 */
export function findPlayerWithDebug(
  teamPlayerName: string,
  statsMap: PlayerStatsMap
): { stats: PlayerStats; matchedKey: string; score: number } | null {
  let bestScore = 0;
  let bestKey = "";
  let bestStats: PlayerStats | null = null;

  for (const [key, stats] of statsMap) {
    const score = nameMatchScore(teamPlayerName, key);
    if (score > bestScore) {
      bestScore = score;
      bestKey = key;
      bestStats = stats;
    }
  }

  return bestScore >= 80 && bestStats
    ? { stats: bestStats, matchedKey: bestKey, score: bestScore }
    : null;
}

// ---------------------------------------------------------------------------
// Dismissal parser (catches & stumpings from outDesc strings)
// ---------------------------------------------------------------------------

interface DismissalResult {
  type: "catch" | "stumping" | "runout" | "none";
  fielder: string | null;
}

/**
 * Parse a Cricbuzz outDesc string, e.g.:
 *   "c Rohit Sharma b J Bumrah"   → catch by "rohit sharma"
 *   "c & b H Pandya"              → catch (and bowl) by "h pandya"
 *   "st MS Dhoni b Y Chahal"      → stumping by "ms dhoni"
 *   "b Bumrah" / "lbw b …"        → no fielder
 *   "not out"                      → none
 */
function parseDismissal(outDesc: string): DismissalResult {
  if (!outDesc) return { type: "none", fielder: null };

  const desc = outDesc.trim();

  // "c & b Bowler" — caught-and-bowled; the bowler is the fielder
  const candBMatch = desc.match(/^c\s*&\s*b\s+(.+)$/i);
  if (candBMatch) {
    return { type: "catch", fielder: normaliseName(candBMatch[1]) };
  }

  // "c <Fielder> b <Bowler>" — standard catch
  // Non-greedy match up to " b " separator
  const catchMatch = desc.match(/^c\s+(.+?)\s+b\s+\S/i);
  if (catchMatch) {
    return { type: "catch", fielder: normaliseName(catchMatch[1]) };
  }

  // "st [†]<Keeper> b <Bowler>"
  const stumpMatch = desc.match(/^st\s+†?(.+?)\s+b\s+\S/i);
  if (stumpMatch) {
    return { type: "stumping", fielder: normaliseName(stumpMatch[1]) };
  }

  // "run out (<Fielder>)" or "run out (<Fielder>/Thrower)"
  // Cricbuzz formats: "run out (Rohit Sharma)" or "run out (Rohit Sharma/Bumrah)"
  const runOutMatch = desc.match(/^run\s+out\s+\(([^/)]+)/i);
  if (runOutMatch) {
    return { type: "runout", fielder: normaliseName(runOutMatch[1].trim()) };
  }

  return { type: "none", fielder: null };
}

// ---------------------------------------------------------------------------
// Scorecard parser
// ---------------------------------------------------------------------------

/**
 * Build a PlayerStatsMap from a raw Cricbuzz scoreCard array.
 * Handles both innings of a T20/ODI match.
 *
 * Supports two Cricbuzz response shapes:
 *  - Real API: innings.batsman[] / innings.bowler[] with bat.name / bowl.name / bat.outdec
 *  - Legacy mock: innings.batTeamDetails.batsmenData{} with bat.batName / bowl.bowlName / bat.outDesc
 */
export function parseScorecardToStats(scoreCard: unknown[]): PlayerStatsMap {
  const stats: PlayerStatsMap = new Map();

  /**
   * Get or create a PlayerStats entry. If no exact normalised key exists,
   * look for an existing entry whose name is a strong fuzzy match (score ≥ 80)
   * so that name variants like "Phil Salt" / "Philip Salt" share one entry.
   */
  function ensurePlayer(name: string): PlayerStats {
    const key = normaliseName(name);
    if (stats.has(key)) return stats.get(key)!;

    // Fuzzy lookup: reuse an existing entry when names clearly refer to the
    // same person (e.g. short-form in dismissal text vs full name in batting).
    let bestScore = 0;
    let bestKey = "";
    for (const existingKey of stats.keys()) {
      const score = nameMatchScore(key, existingKey);
      if (score > bestScore) {
        bestScore = score;
        bestKey = existingKey;
      }
    }
    if (bestScore >= 80 && bestKey) {
      // Also register the new key as an alias so later lookups are O(1)
      const existing = stats.get(bestKey)!;
      stats.set(key, existing);
      return existing;
    }

    stats.set(key, { runs: 0, fours: 0, sixes: 0, wickets: 0, catches: 0, runOuts: 0, stumpings: 0 });
    return stats.get(key)!;
  }

  for (const inningsRaw of scoreCard) {
    const innings = inningsRaw as Record<string, unknown>;

    // -----------------------------------------------------------------------
    // Batsmen
    // -----------------------------------------------------------------------
    const batsmenArray = innings.batsman as Record<string, unknown>[] | undefined;
    const batTeam = innings.batTeamDetails as Record<string, unknown> | undefined;
    const batsmenData = batTeam?.batsmenData as Record<string, unknown> | undefined;

    if (Array.isArray(batsmenArray)) {
      // Real Cricbuzz API format
      for (const bat of batsmenArray) {
        const batName = bat.name as string | undefined;
        if (!batName) continue;

        const runs = Number(bat.runs) || 0;
        const fours = Number(bat.fours) || 0;
        const sixes = Number(bat.sixes) || 0;
        const p = ensurePlayer(batName);
        p.runs += runs;
        p.fours += fours;
        p.sixes += sixes;

        // Real API uses "outdec"; fall back to "outDesc" for mocks
        const outDesc = ((bat.outdec ?? bat.outDesc) as string | undefined);
        if (outDesc) {
          const { type, fielder } = parseDismissal(outDesc);
          if (fielder) {
            if (type === "catch") ensurePlayer(fielder).catches += 1;
            else if (type === "stumping") ensurePlayer(fielder).stumpings += 1;
            else if (type === "runout") ensurePlayer(fielder).runOuts += 1;
          }
        }
      }
    } else if (batsmenData) {
      // Legacy mock format (also matches older API shape)
      for (const key of Object.keys(batsmenData)) {
        const bat = batsmenData[key] as Record<string, unknown>;
        const batName = (bat.batName ?? bat.name) as string | undefined;
        if (!batName) continue;

        const runs = Number(bat.runs) || 0;
        const fours = Number(bat.fours) || 0;
        const sixes = Number(bat.sixes) || 0;
        const p = ensurePlayer(batName);
        p.runs += runs;
        p.fours += fours;
        p.sixes += sixes;

        const outDesc = ((bat.outDesc ?? bat.outdec) as string | undefined);
        if (outDesc) {
          const { type, fielder } = parseDismissal(outDesc);
          if (fielder) {
            if (type === "catch") ensurePlayer(fielder).catches += 1;
            else if (type === "stumping") ensurePlayer(fielder).stumpings += 1;
            else if (type === "runout") ensurePlayer(fielder).runOuts += 1;
          }
        }
      }
    }

    // -----------------------------------------------------------------------
    // Bowlers
    // -----------------------------------------------------------------------
    const bowlersArray = innings.bowler as Record<string, unknown>[] | undefined;
    const bowlTeam = innings.bowlTeamDetails as Record<string, unknown> | undefined;
    const bowlersData = bowlTeam?.bowlersData as Record<string, unknown> | undefined;

    if (Array.isArray(bowlersArray)) {
      // Real Cricbuzz API format
      for (const bowl of bowlersArray) {
        const bowlName = bowl.name as string | undefined;
        if (!bowlName) continue;

        const wickets = Number(bowl.wickets) || 0;
        ensurePlayer(bowlName).wickets += wickets;
      }
    } else if (bowlersData) {
      // Legacy mock format
      for (const key of Object.keys(bowlersData)) {
        const bowl = bowlersData[key] as Record<string, unknown>;
        const bowlName = (bowl.bowlName ?? bowl.name) as string | undefined;
        if (!bowlName) continue;

        const wickets = Number(bowl.wickets) || 0;
        ensurePlayer(bowlName).wickets += wickets;
      }
    }
  }

  // Deduplicate: ensurePlayer may create alias keys pointing to the same
  // PlayerStats object. Keep only the longest (most complete) name per player.
  const canonical = new Map<PlayerStats, string>();
  for (const [key, s] of stats) {
    const prev = canonical.get(s);
    if (!prev || key.length > prev.length) {
      canonical.set(s, key);
    }
  }
  const deduped: PlayerStatsMap = new Map();
  for (const [s, key] of canonical) {
    deduped.set(key, s);
  }

  return deduped;
}

// ---------------------------------------------------------------------------
// Point calculation
// ---------------------------------------------------------------------------

export function calculatePlayerPoints(
  stats: PlayerStats,
  weights: ScoringWeights
): number {
  let pts = 0;

  // Batting
  pts += stats.runs * weights.pointsPerRun;
  pts += stats.fours * weights.pointsPerFour;
  pts += stats.sixes * weights.pointsPerSix;
  if (stats.runs >= 100) pts += weights.centuryBonus;
  else if (stats.runs >= 50) pts += weights.fiftyBonus;

  // Bowling
  pts += stats.wickets * weights.wicketPoints;
  if (stats.wickets >= 5) pts += weights.fiveWicketBonus;
  else if (stats.wickets >= 3) pts += weights.threeWicketBonus;

  // Fielding
  pts += stats.catches * weights.catchPoints;
  pts += stats.runOuts * weights.runOutPoints;
  pts += stats.stumpings * weights.stumpingPoints;

  return pts;
}

/**
 * Calculate points for each player in a fantasy team roster.
 * Returns per-player breakdowns (including 0-pt players found) and totals.
 */
export function calculateTeamPoints(
  players: string[],
  statsMap: PlayerStatsMap,
  weights: ScoringWeights
): {
  playerPoints: PlayerPointBreakdown[];
  total: number;
  unmatched: string[];
} {
  const playerPoints: PlayerPointBreakdown[] = [];
  const unmatched: string[] = [];
  let total = 0;

  for (const playerName of players) {
    const result = findPlayerWithDebug(playerName, statsMap);
    if (!result) {
      unmatched.push(playerName);
      continue;
    }
    const { stats } = result;
    const points = calculatePlayerPoints(stats, weights);
    playerPoints.push({
      playerName,
      runs: stats.runs,
      fours: stats.fours,
      sixes: stats.sixes,
      wickets: stats.wickets,
      catches: stats.catches,
      runOuts: stats.runOuts,
      stumpings: stats.stumpings,
      points,
    });
    total += points;
  }

  return { playerPoints, total, unmatched };
}

// ---------------------------------------------------------------------------
// Cricbuzz API client
// ---------------------------------------------------------------------------

/**
 * Fetch the full scorecard for a given Cricbuzz match ID via RapidAPI.
 * Requires CRICBUZZ_API_KEY in environment.
 */
export async function fetchCricbuzzScorecard(
  cricbuzzMatchId: string
): Promise<unknown[]> {
  const data = await fetchCricbuzz(`/mcenter/v1/${encodeURIComponent(cricbuzzMatchId)}/hscard`);

  // API returns lowercase "scorecard" key
  const scoreCard = data.scoreCard ?? data.scorecard;
  if (!Array.isArray(scoreCard)) {
    throw new Error(
      "Invalid Cricbuzz response: missing scoreCard array. " +
        "Response keys: " +
        Object.keys(data).join(", ")
    );
  }

  return scoreCard as unknown[];
}
