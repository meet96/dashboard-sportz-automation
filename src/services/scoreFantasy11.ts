import Match from "../models/Match";
import LeagueCode from "../models/LeagueCode";
import ScoringConfig from "../models/ScoringConfig";
import Fantasy11Team from "../models/Fantasy11Team";
import Group from "../models/Group";
import User from "../models/User";
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
  opts: { cricbuzzMatchId?: string; allowIncomplete?: boolean } = {}
): Promise<Fantasy11ScoreResult> {
  const match = await Match.findById(matchId);
  if (!match) throw new Error("Match not found");
  if (!match.isCompleted && !opts.allowIncomplete) throw new Error("Match is not marked as completed yet");

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
  // teamId -> raw per-player stat breakdown (runs/fours/sixes/wickets/catches/runOuts/stumpings),
  // captured before the captain/vice-captain point multiplier is applied -- needed to build the
  // Match.scorecard snapshot below, which displays both the awarded points AND the underlying
  // stats (matching what the classic scoring path already stores).
  const teamRawStatsById = new Map<string, { playerName: string; runs: number; fours: number; sixes: number; wickets: number; catches: number; runOuts: number; stumpings: number }[]>();
  const teamUnmatchedById = new Map<string, string[]>();

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
      const { playerPoints, unmatched } = calculateTeamPoints(team.players, statsMap, weights);
      const enhancedPlayerPoints = applyCaptainMultiplier(playerPoints, team.captain ?? "", team.viceCaptain ?? "");
      const total = enhancedPlayerPoints.reduce((sum, pp) => sum + pp.points, 0);

      const teamId = String(team._id);
      teamRawStatsById.set(teamId, playerPoints.map((pp) => ({
        playerName: pp.playerName, runs: pp.runs, fours: pp.fours, sixes: pp.sixes,
        wickets: pp.wickets, catches: pp.catches, runOuts: pp.runOuts, stumpings: pp.stumpings,
      })));
      teamUnmatchedById.set(teamId, unmatched);

      const teamGroupNames = Array.isArray((team as { groupNames?: unknown }).groupNames)
        ? ((team as { groupNames?: unknown[] }).groupNames ?? [])
            .map((g) => (typeof g === "string" ? g.trim() : ""))
            .filter((g): g is string => Boolean(g) && (allowedGroupSet.size === 0 || allowedGroupSet.has(g)))
        : [];

      allRawScores.push({
        teamId,
        userId: team.userId.toString(),
        groupId: (team as { groupId?: unknown }).groupId ? String((team as { groupId?: unknown }).groupId) : null,
        groupNames: teamGroupNames,
        points: total,
        playerPoints: enhancedPlayerPoints,
        unmatched,
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

  // Persist a Match.scorecard snapshot, matching the shape/behavior scoreClassicMatch already
  // uses -- this is what makes the admin "Scorecard" button appear (it's gated on
  // match.scorecard existing). Previously only classic/football-classic scoring wrote this;
  // fantasy11 (and football, see scoreFootball.ts) never did, even though Match's scorecard
  // schema already supports it -- confirmed as a real, pre-existing gap affecting 36% of
  // completed matches in the real database.
  if (allResults.length > 0) {
    const userIds = [...new Set(allResults.map((r) => r.userId))];
    const userDocs = await User.find({ _id: { $in: userIds } }).lean();
    const userNameMap: Record<string, string> = {};
    for (const u of userDocs) userNameMap[u._id.toString()] = u.name;

    const scorecardPlayers = Array.from(statsMap.entries()).map(([name, s]) => ({
      name, runs: s.runs, fours: s.fours, sixes: s.sixes, wickets: s.wickets,
      catches: s.catches, runOuts: s.runOuts, stumpings: s.stumpings,
    }));

    const teamResults = allResults.map((r) => {
      const rawStats = teamRawStatsById.get(r.teamId) ?? [];
      const rawByName = new Map(rawStats.map((s) => [s.playerName, s]));
      const playerPoints = r.playerPoints.map((pp) => {
        const raw = rawByName.get(pp.playerName);
        return {
          playerName: pp.playerName,
          points: pp.points,
          runs: raw?.runs ?? 0, fours: raw?.fours ?? 0, sixes: raw?.sixes ?? 0,
          wickets: raw?.wickets ?? 0, catches: raw?.catches ?? 0, runOuts: raw?.runOuts ?? 0, stumpings: raw?.stumpings ?? 0,
        };
      });
      return {
        teamId: r.teamId,
        // Fantasy11Team has no teamName field (one roster per user per match, unlike classic's
        // 2 named teams) -- "Fantasy XI" is a fixed, descriptive stand-in for the header display.
        teamName: "Fantasy XI",
        userName: userNameMap[r.userId] ?? "Unknown",
        leagueCode: r.leagueCode,
        points: r.points,
        playerPoints,
        unmatched: teamUnmatchedById.get(r.teamId) ?? [],
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

  return { matchId, matchName: match.matchName, cricbuzzMatchId: String(cricbuzzMatchId), teamsScored: allResults.length, teamResults: allResults };
}
