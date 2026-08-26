import Match from "../models/Match";
import ScoringConfig from "../models/ScoringConfig";
import Fantasy11Team from "../models/Fantasy11Team";
import Fantasy11Points from "../models/Fantasy11Points";
import User from "../models/User";
import { fetchAndParseEspnFootballMatch, isGoalkeeperOrDefender, normalizeFootballName } from "../lib/espnFootball";

export interface FootballScoreResult {
  matchId: string;
  matchName: string;
  eventId: string;
  teamsScored: number;
  results: { teamId: string; userId: string; points: number; rankPoints: number }[];
  weights: Record<string, number | undefined>;
}

export async function scoreFootballMatch(
  matchId: string,
  opts: { espnEventId?: string; espnUrl?: string; footballFixtureId?: string; allowIncomplete?: boolean } = {}
): Promise<FootballScoreResult> {
  const match = await Match.findById(matchId).lean();
  if (!match) throw new Error("Match not found");
  if (!match.isCompleted && !opts.allowIncomplete) throw new Error("Match is not marked as completed yet (automation-service)");

  const eventRef = String(
    opts.espnEventId ?? opts.espnUrl ?? opts.footballFixtureId ?? match.cricbuzzMatchId ?? ""
  ).trim();
  if (!eventRef) throw new Error("Missing event reference. Provide espnEventId/espnUrl or store ESPN event id on the match.");

  const config = await ScoringConfig.findOne({ leagueCode: "FIFA" }).lean();
  if (!config) throw new Error("FIFA ScoringConfig not found");

  const parsed = await fetchAndParseEspnFootballMatch(eventRef);

  const statsMap = new Map<string, { name: string; position: string; goals: number; assists: number; yellowCards: number; redCards: number; cleanSheet: boolean; cleanSheetBonus: number; basePoints: number }>();
  for (const p of parsed.playerStats.values()) {
    let pts = p.goals * Number(config.goalPoints ?? 50) + p.assists * Number(config.assistPoints ?? 25);
    let cleanSheetBonus = 0;
    if (p.cleanSheet && isGoalkeeperOrDefender(p.position)) {
      const pos = String(p.position ?? "").toUpperCase();
      cleanSheetBonus = pos === "G" || pos === "GK" ? Number(config.goalkeeperCleanSheetPoints ?? 50) : Number(config.defenderCleanSheetPoints ?? 25);
      pts += cleanSheetBonus;
    }
    pts += p.yellowCards * Number(config.yellowCardPoints ?? -10);
    pts += p.redCards * Number(config.redCardPoints ?? -25);
    statsMap.set(normalizeFootballName(p.name), {
      name: p.name, position: p.position, goals: p.goals, assists: p.assists, yellowCards: p.yellowCards, redCards: p.redCards,
      cleanSheet: p.cleanSheet, cleanSheetBonus, basePoints: pts,
    });
  }

  const teams = await Fantasy11Team.find({ matchId: match._id, leagueCode: "FIFA" }).lean();

  type RawScore = { teamId: string; userId: string; groupId: string | null; groupNames: string[]; points: number; playerPoints: { playerName: string; points: number }[] };
  const allRawScores: RawScore[] = [];
  // teamId -> raw per-player football stats (position/goals/assists/cards/cleanSheetBonus),
  // captured before the captain/vice-captain multiplier -- needed for the Match.scorecard
  // snapshot below (same reasoning as scoreFantasy11Match's teamRawStatsById).
  const teamRawStatsById = new Map<string, { playerName: string; position: string; goals: number; assists: number; yellowCards: number; redCards: number; cleanSheetBonus: number }[]>();

  for (const team of teams) {
    const teamPlayers = Array.isArray(team.players) ? team.players : [];
    const captain = String(team.captain ?? "").trim();
    const viceCaptain = String(team.viceCaptain ?? "").trim();
    let total = 0;
    const playerPoints: { playerName: string; points: number }[] = [];
    const rawStats: { playerName: string; position: string; goals: number; assists: number; yellowCards: number; redCards: number; cleanSheetBonus: number }[] = [];

    for (const playerName of teamPlayers) {
      const key = normalizeFootballName(playerName);
      const stats = statsMap.get(key);
      const basePoints = stats?.basePoints ?? 0;
      const isCaptain = captain && normalizeFootballName(captain) === key;
      const isViceCaptain = viceCaptain && normalizeFootballName(viceCaptain) === key;
      const mult = isCaptain ? 2 : isViceCaptain ? 1.5 : 1;
      const finalPoints = Math.round(basePoints * mult);
      total += finalPoints;
      playerPoints.push({ playerName, points: finalPoints });
      rawStats.push({
        playerName,
        position: stats?.position ?? "",
        goals: stats?.goals ?? 0,
        assists: stats?.assists ?? 0,
        yellowCards: stats?.yellowCards ?? 0,
        redCards: stats?.redCards ?? 0,
        cleanSheetBonus: stats?.cleanSheetBonus ?? 0,
      });
    }

    const teamId = String(team._id);
    teamRawStatsById.set(teamId, rawStats);

    allRawScores.push({
      teamId, userId: String(team.userId),
      groupId: team.groupId ? String(team.groupId) : null,
      groupNames: Array.isArray(team.groupNames) ? (team.groupNames as unknown[]).map((g) => (typeof g === "string" ? g.trim() : "")).filter((g): g is string => Boolean(g)) : [],
      points: total, playerPoints,
    });
  }

  const scoresByGroup = new Map<string, RawScore[]>();
  for (const score of allRawScores) {
    const key = score.groupId ?? "null";
    if (!scoresByGroup.has(key)) scoresByGroup.set(key, []);
    scoresByGroup.get(key)!.push(score);
  }

  const results: FootballScoreResult["results"] = [];
  for (const groupScores of scoresByGroup.values()) {
    groupScores.sort((a, b) => (b.points !== a.points ? b.points - a.points : a.userId.localeCompare(b.userId)));
    const participantCount = groupScores.length;
    let lastPoints: number | null = null;
    let lastRankPosition = 0;

    for (let i = 0; i < groupScores.length; i++) {
      const row = groupScores[i];
      const rankPosition = lastPoints !== null && row.points === lastPoints ? lastRankPosition : i + 1;
      const rankPoints = Math.max(participantCount - rankPosition, 0);
      lastPoints = row.points;
      lastRankPosition = rankPosition;
      const groupIdVal = row.groupId ?? null;

      await Fantasy11Points.findOneAndUpdate(
        { userId: row.userId, matchId: match._id, leagueCode: "FIFA", groupId: groupIdVal },
        { $set: { groupId: groupIdVal, groupNames: row.groupNames, rawPoints: row.points, rankPoints, playerPoints: row.playerPoints } },
        { upsert: true, new: true }
      );
      results.push({ teamId: row.teamId, userId: row.userId, points: row.points, rankPoints });
    }
  }

  await Promise.all(results.map((r) => Fantasy11Team.updateOne({ _id: r.teamId }, { points: r.points, updatedAt: new Date() })));

  // Persist a Match.scorecard snapshot -- same reasoning as scoreFantasy11Match: this is what
  // makes the admin "Scorecard" button appear, and this path never wrote it before.
  if (results.length > 0) {
    const userIds = [...new Set(results.map((r) => r.userId))];
    const userDocs = await User.find({ _id: { $in: userIds } }).lean();
    const userNameMap: Record<string, string> = {};
    for (const u of userDocs) userNameMap[u._id.toString()] = u.name;

    const scorecardPlayers = Array.from(statsMap.values()).map((s) => ({
      name: s.name,
      runs: 0, fours: 0, sixes: 0, wickets: 0, catches: 0, runOuts: 0, stumpings: 0,
      position: s.position, goals: s.goals, assists: s.assists, yellowCards: s.yellowCards, redCards: s.redCards,
    }));

    const teamResults = results.map((r) => {
      const rawStats = teamRawStatsById.get(r.teamId) ?? [];
      const rawByName = new Map(rawStats.map((s) => [s.playerName, s]));
      const scoredTeam = allRawScores.find((s) => s.teamId === r.teamId);
      const playerPoints = (scoredTeam?.playerPoints ?? []).map((pp) => {
        const raw = rawByName.get(pp.playerName);
        return {
          playerName: pp.playerName,
          points: pp.points,
          position: raw?.position ?? "",
          runs: 0, fours: 0, sixes: 0, wickets: 0, catches: 0, runOuts: 0, stumpings: 0,
          goals: raw?.goals ?? 0, assists: raw?.assists ?? 0,
          yellowCards: raw?.yellowCards ?? 0, redCards: raw?.redCards ?? 0,
          cleanSheetBonus: raw?.cleanSheetBonus ?? 0,
        };
      });
      return {
        teamId: r.teamId,
        teamName: "Fantasy XI",
        userName: userNameMap[r.userId] ?? "Unknown",
        leagueCode: "FIFA",
        points: r.points,
        playerPoints,
        unmatched: [] as string[],
      };
    });

    await Match.findByIdAndUpdate(matchId, {
      scorecard: {
        scoredAt: new Date(),
        players: scorecardPlayers,
        teamResults,
      },
    });
  }

  return {
    matchId: String(match._id), matchName: match.matchName, eventId: parsed.eventId,
    teamsScored: results.length, results,
    weights: {
      goalPoints: config.goalPoints, assistPoints: config.assistPoints,
      yellowCardPoints: config.yellowCardPoints, redCardPoints: config.redCardPoints,
      goalkeeperCleanSheetPoints: config.goalkeeperCleanSheetPoints, defenderCleanSheetPoints: config.defenderCleanSheetPoints,
    },
  };
}
