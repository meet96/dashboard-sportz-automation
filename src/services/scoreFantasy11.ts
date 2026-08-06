import Match from "../models/Match";
import LeagueCode from "../models/LeagueCode";
import ScoringConfig from "../models/ScoringConfig";
import Fantasy11Team from "../models/Fantasy11Team";
import Group from "../models/Group";
import {
  fetchCricbuzzScorecard,
  parseScorecardToStats,
  calculateTeamPoints,
  DEFAULT_WEIGHTS,
  ScoringWeights,
} from "../lib/cricbuzz";
import { rankAndSaveFantasy11Group, applyCaptainMultiplier, type TeamRawScore } from "../lib/fantasy11Scoring";
import { resolveScoringWeights } from "../lib/resolveScoringWeights";

export interface Fantasy11ScoreResult {
  matchId: string;
  matchName: string;
  cricbuzzMatchId: string;
  teamsScored: number;
  teamResults: { leagueCode: string; userId: string; teamId: string; points: number; rankPoints: number; playerPoints: { playerName: string; points: number }[] }[];
}

export async function scoreFantasy11Match(
  matchId: string,
  opts: { cricbuzzMatchId?: string } = {}
): Promise<Fantasy11ScoreResult> {
  const match = await Match.findById(matchId);
  if (!match) throw new Error("Match not found");
  if (!match.isCompleted) throw new Error("Match is not marked as completed yet");

  const providedId = opts.cricbuzzMatchId?.trim();
  const cricbuzzMatchId = providedId || match.cricbuzzMatchId;
  if (!cricbuzzMatchId) throw new Error("cricbuzzMatchId is required. Pass it in opts or save it on the match.");

  const fantasyLeagues = await LeagueCode.find({
    code: { $in: match.leagueCodes },
    gameType: { $in: ["fantasy11", "advanced"] },
  }).lean();
  if (fantasyLeagues.length === 0) throw new Error("No fantasy11 leagues found for this match");

  const scoreCard = await fetchCricbuzzScorecard(String(cricbuzzMatchId));
  const statsMap = parseScorecardToStats(scoreCard);

  const allResults: Fantasy11ScoreResult["teamResults"] = [];

  for (const league of fantasyLeagues) {
    const linkedGroups = await Group.find({
      isActive: true,
      $or: [{ leagueCodes: league.code }, { leagueCode: league.code }],
    }).select("name").lean();
    const allowedGroupSet = new Set(linkedGroups.map((g) => g.name).filter(Boolean));

    const cfg = await ScoringConfig.findOne({ leagueCode: league.code }).lean();
    const fantasy11Defaults: ScoringWeights = { ...DEFAULT_WEIGHTS, teamSize: 11 };
    const weights = resolveScoringWeights(cfg, fantasy11Defaults);

    const teams = await Fantasy11Team.find({ matchId: match._id, leagueCode: league.code }).lean();
    const allRawScores: TeamRawScore[] = [];

    for (const team of teams) {
      const { playerPoints } = calculateTeamPoints(team.players, statsMap, weights);
      const enhancedPlayerPoints = applyCaptainMultiplier(playerPoints, team.captain ?? "", team.viceCaptain ?? "");
      const total = enhancedPlayerPoints.reduce((sum, pp) => sum + pp.points, 0);

      const teamGroupNames = Array.isArray((team as { groupNames?: unknown }).groupNames)
        ? ((team as { groupNames?: unknown[] }).groupNames ?? [])
            .map((g) => (typeof g === "string" ? g.trim() : ""))
            .filter((g): g is string => Boolean(g) && (allowedGroupSet.size === 0 || allowedGroupSet.has(g)))
        : [];

      allRawScores.push({
        teamId: String(team._id),
        userId: team.userId.toString(),
        groupId: (team as { groupId?: unknown }).groupId ? String((team as { groupId?: unknown }).groupId) : null,
        groupNames: teamGroupNames,
        points: total,
        playerPoints: enhancedPlayerPoints,
      });
    }

    const scoresByGroup = new Map<string, TeamRawScore[]>();
    for (const score of allRawScores) {
      const key = score.groupId ?? "null";
      if (!scoresByGroup.has(key)) scoresByGroup.set(key, []);
      scoresByGroup.get(key)!.push(score);
    }

    for (const groupScores of scoresByGroup.values()) {
      const ranked = await rankAndSaveFantasy11Group(String(match._id), league.code, groupScores);
      for (const row of ranked) {
        allResults.push({
          leagueCode: league.code, userId: row.userId, teamId: row.teamId,
          points: row.points, rankPoints: row.rankPoints, playerPoints: row.playerPoints,
        });
      }
    }
  }

  return { matchId, matchName: match.matchName, cricbuzzMatchId: String(cricbuzzMatchId), teamsScored: allResults.length, teamResults: allResults };
}
