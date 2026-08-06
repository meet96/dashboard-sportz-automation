import Match from "../models/Match";
import ClassicTeam from "../models/ClassicTeam";
import ClassicPoints from "../models/ClassicPoints";
import ScoringConfig from "../models/ScoringConfig";
import User from "../models/User";
import { resolveClassicScoringTargets, classicTeamFilterForTarget } from "../lib/resolveClassicScoringTargets";
import {
  fetchCricbuzzScorecard,
  parseScorecardToStats,
  calculateTeamPoints,
  DEFAULT_WEIGHTS,
} from "../lib/cricbuzz";
import { resolveScoringWeights } from "../lib/resolveScoringWeights";

const WOLFPACK_TEAM_NAMES = ["MI", "CSK", "RCB", "SRH", "PBKS", "LSG", "DC", "RR", "KKR", "GT"];

export interface ClassicScoreResult {
  matchId: string;
  matchName: string;
  cricbuzzMatchId: string;
  teamsScored: number;
  totalPoints: number;
  leagues: Record<string, { teams: number; points: number }>;
  teamResults: {
    teamId: string; teamName: string; userName: string; leagueCode: string; points: number;
    matched: string[]; unmatched: string[];
    playerPoints: { playerName: string; points: number; runs: number; fours: number; sixes: number; wickets: number; catches: number; runOuts: number; stumpings: number }[];
  }[];
  scorecardPlayers: { name: string; runs: number; fours: number; sixes: number; wickets: number; catches: number; runOuts: number; stumpings: number }[];
}

export async function scoreClassicMatch(
  matchId: string,
  opts: { cricbuzzMatchId?: string } = {}
): Promise<ClassicScoreResult> {
  const match = await Match.findById(matchId);
  if (!match) throw new Error("Match not found");
  if (!match.isCompleted) throw new Error("Match is not marked as completed yet");

  const providedId = opts.cricbuzzMatchId?.trim();
  const cricbuzzMatchId = providedId || match.cricbuzzMatchId;
  if (!cricbuzzMatchId) {
    throw new Error("cricbuzzMatchId is required. Pass it in opts or save it on the match first.");
  }

  if (providedId && providedId !== match.cricbuzzMatchId) {
    await Match.findByIdAndUpdate(matchId, { cricbuzzMatchId: providedId });
  }

  const targets = await resolveClassicScoringTargets(match);
  if (targets.length === 0) throw new Error("No classic-type leagues found for this match");

  const scoreCard = await fetchCricbuzzScorecard(String(cricbuzzMatchId));
  const statsMap = parseScorecardToStats(scoreCard);

  const allClassicTeamDocs = await ClassicTeam.find({ $or: targets.map((t) => classicTeamFilterForTarget(t)) }).lean();
  const userIds = [...new Set(allClassicTeamDocs.map((t) => t.userId.toString()))];
  const userDocs = await User.find({ _id: { $in: userIds } }).lean();
  const userNameMap: Record<string, string> = {};
  for (const u of userDocs) userNameMap[u._id.toString()] = u.name;

  let totalTeamsScored = 0;
  let totalPointsAwarded = 0;
  const leagueSummary: Record<string, { teams: number; points: number }> = {};
  const teamResults: ClassicScoreResult["teamResults"] = [];

  for (const target of targets) {
    const league = target.league;
    const cfg = await ScoringConfig.findOne({ leagueCode: league.code }).lean();
    const weights = resolveScoringWeights(cfg, DEFAULT_WEIGHTS);

    const teams = await ClassicTeam.find(classicTeamFilterForTarget(target)).lean();
    let leaguePoints = 0;

    for (const team of teams) {
      const { playerPoints, total, unmatched } = calculateTeamPoints(team.players, statsMap, weights);
      const scoredMap = new Map(playerPoints.map((pp) => [pp.playerName, pp.points]));
      const canonicalPlayerPoints = team.players.map((playerName: string, slotIndex: number) => ({
        playerName,
        points: scoredMap.get(playerName) ?? 0,
        slotIndex,
        teamCode: team.players.length === WOLFPACK_TEAM_NAMES.length ? WOLFPACK_TEAM_NAMES[slotIndex] : undefined,
      }));

      await ClassicPoints.findOneAndUpdate(
        { teamId: team._id, matchId: match._id },
        { $set: { points: total, playerPoints: canonicalPlayerPoints } },
        { upsert: true }
      );

      leaguePoints += total;
      totalTeamsScored++;
      totalPointsAwarded += total;

      teamResults.push({
        teamId: String(team._id),
        teamName: team.teamName || String(team._id),
        userName: userNameMap[team.userId.toString()] ?? "Unknown",
        leagueCode: league.code,
        points: total,
        matched: playerPoints.map((pp) => `${pp.playerName} (${pp.points}pts: ${pp.runs}r ${pp.fours}×4 ${pp.sixes}×6 ${pp.wickets}w ${pp.catches}c ${pp.runOuts}ro ${pp.stumpings}st)`),
        unmatched,
        playerPoints: playerPoints.map((pp) => ({
          playerName: pp.playerName, points: pp.points, runs: pp.runs, fours: pp.fours, sixes: pp.sixes,
          wickets: pp.wickets, catches: pp.catches, runOuts: pp.runOuts, stumpings: pp.stumpings,
        })),
      });
    }

    leagueSummary[league.code] = { teams: teams.length, points: leaguePoints };
  }

  const scorecardPlayers = Array.from(statsMap.entries()).map(([name, s]) => ({
    name, runs: s.runs, fours: s.fours, sixes: s.sixes, wickets: s.wickets, catches: s.catches, runOuts: s.runOuts, stumpings: s.stumpings,
  }));

  await Match.findByIdAndUpdate(matchId, {
    scorecard: {
      scoredAt: new Date(),
      players: scorecardPlayers,
      teamResults: teamResults.map((tr) => ({
        teamId: tr.teamId, teamName: tr.teamName, userName: tr.userName, leagueCode: tr.leagueCode,
        points: tr.points, playerPoints: tr.playerPoints, unmatched: tr.unmatched,
      })),
    },
  });

  return {
    matchId, matchName: match.matchName, cricbuzzMatchId: String(cricbuzzMatchId),
    teamsScored: totalTeamsScored, totalPoints: totalPointsAwarded,
    leagues: leagueSummary, teamResults, scorecardPlayers,
  };
}
