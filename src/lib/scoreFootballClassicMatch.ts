import Match from "../models/Match";
import ClassicTeam from "../models/ClassicTeam";
import ClassicPoints from "../models/ClassicPoints";
import ClassicBonus from "../models/ClassicBonus";
import ClassicMOM from "../models/ClassicMOM";
import ScoringConfig from "../models/ScoringConfig";
import LeagueCode from "../models/LeagueCode";
import Series from "../models/Series";
import User from "../models/User";
import { fetchAndParseEspnFootballMatch, normalizeFootballName } from "./espnFootball";
import type { EspnFootballPlayerStat } from "./espnFootball";

interface FootballScoringWeights {
  strikerGoalPoints: number;
  midfielderGoalPoints: number;
  defenderGoalPoints: number;
  goalkeeperGoalPoints: number;
  strikerAssistPoints: number;
  midfielderAssistPoints: number;
  defenderAssistPoints: number;
  goalkeeperAssistPoints: number;
  yellowCardPoints: number;
  redCardPoints: number;
  goalkeeperCleanSheetPoints: number;
  defenderCleanSheetPoints: number;
  teamSize: number;
  hatTrickBonus: number;
  footballMomBonus: number;
}

const DEFAULT_FOOTBALL_WEIGHTS: FootballScoringWeights = {
  strikerGoalPoints: 10,
  midfielderGoalPoints: 20,
  defenderGoalPoints: 30,
  goalkeeperGoalPoints: 50,
  strikerAssistPoints: 10,
  midfielderAssistPoints: 10,
  defenderAssistPoints: 20,
  goalkeeperAssistPoints: 30,
  yellowCardPoints: -10,
  redCardPoints: -30,
  goalkeeperCleanSheetPoints: 30,
  defenderCleanSheetPoints: 20,
  teamSize: 11,
  hatTrickBonus: 50,
  footballMomBonus: 20,
};

function getFootballRole(position: string): "goalkeeper" | "defender" | "midfielder" | "striker" {
  const p = String(position ?? "").toUpperCase();
  if (p === "GK" || p === "G" || p.includes("KEEP")) return "goalkeeper";
  if (p === "D" || p.startsWith("CD") || p === "CB" || p === "LB" || p === "RB" || p === "LWB" || p === "RWB" || p === "SW" || p.includes("DEF") || p.includes("BACK")) return "defender";
  if (p === "M" || p.startsWith("CM") || p.startsWith("DM") || p.startsWith("AM") || p === "LM" || p === "RM" || p.includes("MID")) return "midfielder";
  return "striker";
}

function goalPointsForRole(role: "goalkeeper" | "defender" | "midfielder" | "striker", w: FootballScoringWeights): number {
  if (role === "goalkeeper") return w.goalkeeperGoalPoints;
  if (role === "defender") return w.defenderGoalPoints;
  if (role === "midfielder") return w.midfielderGoalPoints;
  return w.strikerGoalPoints;
}

function assistPointsForRole(role: "goalkeeper" | "defender" | "midfielder" | "striker", w: FootballScoringWeights): number {
  if (role === "goalkeeper") return w.goalkeeperAssistPoints;
  if (role === "defender") return w.defenderAssistPoints;
  if (role === "midfielder") return w.midfielderAssistPoints;
  return w.strikerAssistPoints;
}

function calculateFootballTeamPoints(
  teamPlayerNames: string[],
  allPlayerStats: Map<string, EspnFootballPlayerStat>,
  weights: FootballScoringWeights,
  homeTeamId: string,
  awayTeamId: string,
  homeCleanSheet: boolean,
  awayCleanSheet: boolean
) {
  const playerPoints: Array<{
    playerName: string;
    points: number;
    goals: number;
    assists: number;
    yellowCards: number;
    redCards: number;
    cleanSheetBonus: number;
  }> = [];
  const matchedNormalized = new Set<string>();
  let total = 0;

  for (const rawPlayerName of teamPlayerNames) {
    const playerName = rawPlayerName.trim();
    if (!playerName) continue;

    const normalizedName = normalizeFootballName(playerName);
    const stats = allPlayerStats.get(normalizedName);
    if (!stats) continue;

    matchedNormalized.add(normalizedName);
    let pts = 0;
    const role = getFootballRole(stats.position);

    // First 3 goals at the normal position rate; every goal from the 4th onward at double
    // that rate.
    const goalRate = goalPointsForRole(role, weights);
    const normalGoals = Math.min(stats.goals, 3);
    const doubledGoals = Math.max(stats.goals - 3, 0);
    pts += normalGoals * goalRate + doubledGoals * goalRate * 2;
    pts += stats.assists * assistPointsForRole(role, weights);

    let cleanSheetBonus = 0;
    const playerOnHome = stats.teamId === homeTeamId;
    const playerOnAway = stats.teamId === awayTeamId;

    if (role === "goalkeeper" && ((playerOnHome && homeCleanSheet) || (playerOnAway && awayCleanSheet))) {
      cleanSheetBonus += weights.goalkeeperCleanSheetPoints;
    }
    if (role === "defender" && ((playerOnHome && homeCleanSheet) || (playerOnAway && awayCleanSheet))) {
      cleanSheetBonus += weights.defenderCleanSheetPoints;
    }
    pts += cleanSheetBonus;

    pts += stats.yellowCards * weights.yellowCardPoints;
    pts += stats.redCards * weights.redCardPoints;

    playerPoints.push({ playerName, points: pts, goals: stats.goals, assists: stats.assists, yellowCards: stats.yellowCards, redCards: stats.redCards, cleanSheetBonus });
    total += pts;
  }

  const unmatched = teamPlayerNames.filter((p) => {
    const t = p.trim();
    return t && !matchedNormalized.has(normalizeFootballName(t));
  });

  return { playerPoints, total, unmatched };
}

export interface FootballClassicMatchResult {
  espnMatchId: string;
  teamsScored: number;
  totalPoints: number;
  leagueSummary: Record<string, { teams: number; points: number }>;
  teamResults: Array<{
    teamId: string;
    teamName: string;
    userName: string;
    leagueCode: string;
    points: number;
    matched: string[];
    unmatched: string[];
    playerPoints: Array<{
      playerName: string;
      points: number;
      position: string;
      runs: number; fours: number; sixes: number; wickets: number; catches: number; runOuts: number; stumpings: number;
      goals: number; assists: number; yellowCards: number; redCards: number; cleanSheetBonus: number;
    }>;
  }>;
  scorecardPlayers: Array<{
    name: string; position: string; goals: number; assists: number; yellowCards: number; redCards: number;
  }>;
}

export async function scoreFootballClassicMatch(
  matchId: string,
  cricbuzzMatchIdOverride?: string
): Promise<FootballClassicMatchResult> {
  const match = await Match.findById(matchId).lean();
  if (!match) throw new Error("Match not found");

  const cricbuzzMatchId = cricbuzzMatchIdOverride || match.cricbuzzMatchId;
  if (!cricbuzzMatchId) throw new Error("No ESPN match ID on this match");

  const classicLeagues = await LeagueCode.find({
    code: { $in: match.leagueCodes },
    gameType: "classic",
  }).lean();

  const footballClassicLeagues = classicLeagues.filter((l) =>
    /football/i.test(String((l as { code?: string }).code ?? "")) ||
    /football/i.test(String((l as { name?: string }).name ?? ""))
  );

  if (footballClassicLeagues.length === 0) {
    throw new Error("No football-classic leagues found for this match");
  }

  const espnData = await fetchAndParseEspnFootballMatch(String(cricbuzzMatchId));

  const allPlayerStats = new Map<string, EspnFootballPlayerStat>();
  for (const stats of espnData.playerStats.values()) {
    const normalizedName = normalizeFootballName(String(stats.name || ""));
    allPlayerStats.set(normalizedName, {
      name: String(stats.name || ""),
      teamId: String(stats.teamId || ""),
      position: String(stats.position || ""),
      goals: Number(stats.goals || 0),
      assists: Number(stats.assists || 0),
      yellowCards: Number(stats.yellowCards || 0),
      redCards: Number(stats.redCards || 0),
      cleanSheet: false,
    });
  }

  const homeCleanSheet = espnData.awayTeam.score === 0;
  const awayCleanSheet = espnData.homeTeam.score === 0;

  const matchSeriesMap: Record<string, string | null> = {};
  for (const league of footballClassicLeagues) {
    const seriesDoc = match.series?.length
      ? await Series.findOne({ leagueCode: league.code, name: { $in: match.series } }).lean()
      : null;
    matchSeriesMap[league.code] = seriesDoc ? (seriesDoc as { _id: { toString(): string } })._id.toString() : null;
  }

  const allClassicTeamDocs = await ClassicTeam.find({
    $or: footballClassicLeagues.map((l) => ({
      leagueCode: l.code,
      seriesId: matchSeriesMap[l.code] ?? null,
    })),
  }).lean();

  const userIds = [...new Set(allClassicTeamDocs.map((t) => t.userId.toString()))];
  const userDocs = await User.find({ _id: { $in: userIds } }).lean();
  const userNameMap: Record<string, string> = {};
  for (const u of userDocs) userNameMap[u._id.toString()] = u.name;

  let totalTeamsScored = 0;
  let totalPointsAwarded = 0;
  const leagueSummary: Record<string, { teams: number; points: number }> = {};
  const teamResults: FootballClassicMatchResult["teamResults"] = [];

  for (const league of footballClassicLeagues) {
    const cfg = await ScoringConfig.findOne({ leagueCode: league.code }).lean();
    const weights: FootballScoringWeights = cfg
      ? {
          strikerGoalPoints: (cfg as any).strikerGoalPoints ?? DEFAULT_FOOTBALL_WEIGHTS.strikerGoalPoints,
          midfielderGoalPoints: (cfg as any).midfielderGoalPoints ?? DEFAULT_FOOTBALL_WEIGHTS.midfielderGoalPoints,
          defenderGoalPoints: (cfg as any).defenderGoalPoints ?? DEFAULT_FOOTBALL_WEIGHTS.defenderGoalPoints,
          goalkeeperGoalPoints: (cfg as any).goalkeeperGoalPoints ?? DEFAULT_FOOTBALL_WEIGHTS.goalkeeperGoalPoints,
          strikerAssistPoints: (cfg as any).strikerAssistPoints ?? DEFAULT_FOOTBALL_WEIGHTS.strikerAssistPoints,
          midfielderAssistPoints: (cfg as any).midfielderAssistPoints ?? DEFAULT_FOOTBALL_WEIGHTS.midfielderAssistPoints,
          defenderAssistPoints: (cfg as any).defenderAssistPoints ?? DEFAULT_FOOTBALL_WEIGHTS.defenderAssistPoints,
          goalkeeperAssistPoints: (cfg as any).goalkeeperAssistPoints ?? DEFAULT_FOOTBALL_WEIGHTS.goalkeeperAssistPoints,
          yellowCardPoints: (cfg as any).yellowCardPoints ?? DEFAULT_FOOTBALL_WEIGHTS.yellowCardPoints,
          redCardPoints: (cfg as any).redCardPoints ?? DEFAULT_FOOTBALL_WEIGHTS.redCardPoints,
          goalkeeperCleanSheetPoints: (cfg as any).goalkeeperCleanSheetPoints ?? DEFAULT_FOOTBALL_WEIGHTS.goalkeeperCleanSheetPoints,
          defenderCleanSheetPoints: (cfg as any).defenderCleanSheetPoints ?? DEFAULT_FOOTBALL_WEIGHTS.defenderCleanSheetPoints,
          teamSize: (cfg as any).teamSize ?? DEFAULT_FOOTBALL_WEIGHTS.teamSize,
          hatTrickBonus: (cfg as any).hatTrickBonus ?? DEFAULT_FOOTBALL_WEIGHTS.hatTrickBonus,
          footballMomBonus: (cfg as any).footballMomBonus ?? DEFAULT_FOOTBALL_WEIGHTS.footballMomBonus,
        }
      : DEFAULT_FOOTBALL_WEIGHTS;

    const teams = await ClassicTeam.find({
      leagueCode: league.code,
      seriesId: matchSeriesMap[league.code] ?? null,
    }).lean();

    let leaguePoints = 0;

    for (const team of teams) {
      const { playerPoints, total, unmatched } = calculateFootballTeamPoints(
        team.players,
        allPlayerStats,
        weights,
        espnData.homeTeam.id,
        espnData.awayTeam.id,
        homeCleanSheet,
        awayCleanSheet
      );

      // Hat-trick bonus: hatTrickBonus per hat-trick occurrence this run (a player drafted into
      // two of the user's team slots who both hit 3+ goals counts twice -- intentional). Written
      // as a deterministic $set of the full recomputed total (like ClassicPoints above) rather
      // than an accumulating $inc, so re-scoring the same live match repeatedly doesn't
      // multiply the bonus. Only written when > 0 so users without a hat-trick this match keep
      // whatever bonusPoints value they already had (e.g. a manual admin bonus).
      const hatTrickOccurrences = playerPoints.filter((pp) => pp.goals >= 3).length;
      if (hatTrickOccurrences > 0) {
        await ClassicBonus.findOneAndUpdate(
          { userId: team.userId, matchId: match._id, leagueCode: league.code },
          {
            $set: { bonusPoints: hatTrickOccurrences * weights.hatTrickBonus },
            $setOnInsert: { groupId: (team as { groupId?: unknown }).groupId ?? null, seriesId: (team as { seriesId?: unknown }).seriesId ?? null },
          },
          { upsert: true }
        );
      }

      const playerPointsByName = new Map(
        playerPoints.map((pp) => [normalizeFootballName(pp.playerName), pp])
      );

      const canonicalPlayerPoints = team.players.map((playerName) => {
        const m = playerPointsByName.get(normalizeFootballName(playerName));
        return {
          playerName,
          points: m?.points ?? 0,
          goals: m?.goals ?? 0,
          assists: m?.assists ?? 0,
          yellowCards: m?.yellowCards ?? 0,
          redCards: m?.redCards ?? 0,
          cleanSheetBonus: m?.cleanSheetBonus ?? 0,
        };
      });

      await ClassicPoints.findOneAndUpdate(
        { teamId: team._id, matchId: match._id },
        { $set: { points: total, playerPoints: canonicalPlayerPoints } },
        { upsert: true }
      );

      leaguePoints += total;
      totalPointsAwarded += total;
      totalTeamsScored++;

      const matched = playerPoints.map((p) => `${p.playerName} (${p.points}pts)`);
      const playerPointsForScorecard = playerPoints.map((p) => ({
        playerName: p.playerName,
        points: p.points,
        position: allPlayerStats.get(normalizeFootballName(p.playerName))?.position ?? "",
        runs: 0, fours: 0, sixes: 0, wickets: 0, catches: 0, runOuts: 0, stumpings: 0,
        goals: p.goals,
        assists: p.assists,
        yellowCards: p.yellowCards,
        redCards: p.redCards,
        cleanSheetBonus: p.cleanSheetBonus,
      }));

      teamResults.push({
        teamId: team._id.toString(),
        teamName: team.teamName,
        userName: userNameMap[team.userId.toString()] || "Unknown",
        leagueCode: league.code,
        points: total,
        matched,
        unmatched,
        playerPoints: playerPointsForScorecard,
      });
    }

    leagueSummary[league.code] = { teams: teams.length, points: leaguePoints };
  }

  // Persist scorecard snapshot
  await Match.findByIdAndUpdate(matchId, {
    $set: {
      scorecard: {
        players: Array.from(allPlayerStats.entries()).map(([, s]) => ({
          name: s.name,
          runs: 0, fours: 0, sixes: 0, wickets: 0, catches: 0, runOuts: 0, stumpings: 0,
          position: s.position,
          goals: s.goals,
          assists: s.assists,
          yellowCards: s.yellowCards,
          redCards: s.redCards,
        })),
        teamResults: teamResults as any,
      },
    },
  });

  if (cricbuzzMatchIdOverride && cricbuzzMatchIdOverride !== match.cricbuzzMatchId) {
    await Match.findByIdAndUpdate(matchId, { cricbuzzMatchId: cricbuzzMatchIdOverride });
  }

  return {
    espnMatchId: String(cricbuzzMatchId),
    teamsScored: totalTeamsScored,
    totalPoints: totalPointsAwarded,
    leagueSummary,
    teamResults,
    scorecardPlayers: Array.from(allPlayerStats.entries()).map(([, s]) => ({
      name: s.name,
      position: s.position,
      goals: s.goals,
      assists: s.assists,
      yellowCards: s.yellowCards,
      redCards: s.redCards,
    })),
  };
}

// Admin picks the real-world Man of the Match (ESPN has no MOTM field -- confirmed during
// design, see the spec) -- this finds every Classic team in this league+series with that
// player on its roster and auto-credits each affected user's ClassicMOM row, so the admin
// doesn't have to look up or calculate who gets the bonus themselves.
export async function applyFootballMomBonus(
  matchId: string,
  leagueCode: string,
  playerName: string
): Promise<{ affectedUsers: string[] }> {
  const match = await Match.findById(matchId).lean();
  if (!match) throw new Error("Match not found");

  const cfg = await ScoringConfig.findOne({ leagueCode }).lean();
  const momBonus = (cfg as { footballMomBonus?: number } | null)?.footballMomBonus ?? DEFAULT_FOOTBALL_WEIGHTS.footballMomBonus;

  const seriesDoc = match.series?.length
    ? await Series.findOne({ leagueCode, name: { $in: match.series } }).lean()
    : null;
  const seriesId = seriesDoc ? (seriesDoc as { _id: { toString(): string } })._id.toString() : null;

  const normalizedTarget = normalizeFootballName(playerName);
  const teams = await ClassicTeam.find({ leagueCode, seriesId }).lean();
  const matchingTeams = teams.filter((t) =>
    (t.players ?? []).some((p) => normalizeFootballName(p) === normalizedTarget)
  );

  const matchingUserIds = [...new Set(matchingTeams.map((t) => t.userId.toString()))];

  // Correct a prior wrong pick / make re-applying the same pick a no-op: reset any existing
  // MOM credit for this match+league that belongs to a user no longer holding the selected
  // player, then $set (not $inc) the bonus for currently-matching users. This makes clicking
  // "Apply MOM Bonus" twice for the same player idempotent, and switching to a different player
  // correctly removes the old credit instead of leaving it stranded.
  await ClassicMOM.updateMany(
    { matchId: match._id, leagueCode, userId: { $nin: matchingUserIds } },
    { $set: { momPoints: 0 } }
  );

  const userIds = new Set<string>();
  for (const team of matchingTeams) {
    await ClassicMOM.findOneAndUpdate(
      { userId: team.userId, matchId: match._id, leagueCode },
      {
        $set: { momPoints: momBonus },
        $setOnInsert: { groupId: (team as { groupId?: unknown }).groupId ?? null, seriesId: (team as { seriesId?: unknown }).seriesId ?? null },
      },
      { upsert: true }
    );
    userIds.add(team.userId.toString());
  }

  const userDocs = await User.find({ _id: { $in: [...userIds] } }).select("name").lean();
  return { affectedUsers: userDocs.map((u) => u.name) };
}
