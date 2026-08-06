import Match from "../models/Match";
import ScoringConfig from "../models/ScoringConfig";
import Fantasy11Team from "../models/Fantasy11Team";
import Fantasy11Points from "../models/Fantasy11Points";
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
  opts: { espnEventId?: string; espnUrl?: string; footballFixtureId?: string } = {}
): Promise<FootballScoreResult> {
  const match = await Match.findById(matchId).lean();
  if (!match) throw new Error("Match not found");
  if (!match.isCompleted) throw new Error("Match is not marked as completed yet");

  const eventRef = String(
    opts.espnEventId ?? opts.espnUrl ?? opts.footballFixtureId ?? match.cricbuzzMatchId ?? ""
  ).trim();
  if (!eventRef) throw new Error("Missing event reference. Provide espnEventId/espnUrl or store ESPN event id on the match.");

  const config = await ScoringConfig.findOne({ leagueCode: "FIFA" }).lean();
  if (!config) throw new Error("FIFA ScoringConfig not found");

  const parsed = await fetchAndParseEspnFootballMatch(eventRef);

  const statsMap = new Map<string, { position: string; goals: number; assists: number; yellowCards: number; redCards: number; cleanSheet: boolean; basePoints: number }>();
  for (const p of parsed.playerStats.values()) {
    let pts = p.goals * Number(config.goalPoints ?? 50) + p.assists * Number(config.assistPoints ?? 25);
    if (p.cleanSheet && isGoalkeeperOrDefender(p.position)) {
      const pos = String(p.position ?? "").toUpperCase();
      pts += pos === "G" || pos === "GK" ? Number(config.goalkeeperCleanSheetPoints ?? 50) : Number(config.defenderCleanSheetPoints ?? 25);
    }
    pts += p.yellowCards * Number(config.yellowCardPoints ?? -10);
    pts += p.redCards * Number(config.redCardPoints ?? -25);
    statsMap.set(normalizeFootballName(p.name), {
      position: p.position, goals: p.goals, assists: p.assists, yellowCards: p.yellowCards, redCards: p.redCards, cleanSheet: p.cleanSheet, basePoints: pts,
    });
  }

  const teams = await Fantasy11Team.find({ matchId: match._id, leagueCode: "FIFA" }).lean();

  type RawScore = { teamId: string; userId: string; groupId: string | null; groupNames: string[]; points: number; playerPoints: { playerName: string; points: number }[] };
  const allRawScores: RawScore[] = [];

  for (const team of teams) {
    const teamPlayers = Array.isArray(team.players) ? team.players : [];
    const captain = String(team.captain ?? "").trim();
    const viceCaptain = String(team.viceCaptain ?? "").trim();
    let total = 0;
    const playerPoints: { playerName: string; points: number }[] = [];

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
    }

    allRawScores.push({
      teamId: String(team._id), userId: String(team.userId),
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
