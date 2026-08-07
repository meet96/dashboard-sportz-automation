import type { Job } from "agenda";
import Match, { IMatch } from "../models/Match";
import LeagueCode from "../models/LeagueCode";
import { fetchCricbuzzMatchStatus } from "../lib/cricbuzzStatus";
import { fetchEspnMatchStatus } from "../lib/espnStatus";
import { hasActiveContestForMatch } from "../lib/hasActiveContestForMatch";
import { scoreClassicMatch } from "../services/scoreClassic";
import { scoreFantasy11Match } from "../services/scoreFantasy11";
import { scoreFootballMatch } from "../services/scoreFootball";
import { scoreFootballClassicMatchService } from "../services/scoreFootballClassic";
import { resolveClassicScoringTargets } from "../lib/resolveClassicScoringTargets";

export const LIVE_JOB_NAME = "check-live-matches";

// Same base candidate shape as the recurring sweep (not yet completed, not no-result, already
// started per its scheduled date, has a real provider id) -- live-scoring only ever considers
// matches that would ALSO be sweep candidates, it just acts on them earlier (while in progress)
// rather than waiting for them to finish.
async function findLiveCandidateMatches(): Promise<IMatch[]> {
  return Match.find({
    isCompleted: false,
    noResult: false,
    date: { $lte: new Date() },
    cricbuzzMatchId: { $exists: true, $ne: null },
  })
    .limit(50)
    .exec();
}

async function liveScoreCricketMatch(match: IMatch) {
  const results: Record<string, unknown> = {};
  const leagues = await LeagueCode.find({ code: { $in: match.leagueCodes } }).lean();
  const hasFantasy = leagues.some((l) => l.gameType === "fantasy11" || l.gameType === "advanced");
  const classicTargets = await resolveClassicScoringTargets(match);

  if (classicTargets.length > 0) {
    results.classic = await scoreClassicMatch(String(match._id), { allowIncomplete: true });
  }
  if (hasFantasy) {
    results.fantasy11 = await scoreFantasy11Match(String(match._id), { allowIncomplete: true });
  }
  return results;
}

async function liveScoreFootballMatch(match: IMatch) {
  const results: Record<string, unknown> = {};
  const leagues = await LeagueCode.find({ code: { $in: match.leagueCodes } }).lean();
  const hasFootball = leagues.some((l) => l.gameType === "football");
  const hasFootballClassic = leagues.some((l) => l.gameType === "classic" && (/football/i.test(l.code) || /football/i.test(l.name)));

  if (hasFootball) {
    results.football = await scoreFootballMatch(String(match._id), { allowIncomplete: true });
  }
  if (hasFootballClassic) {
    // scoreFootballClassicMatchService has no isCompleted guard at all -- no allowIncomplete needed.
    results.footballClassic = await scoreFootballClassicMatchService(String(match._id));
  }
  return results;
}

export function defineCheckLiveMatchesJob(agenda: import("agenda").default) {
  agenda.define(LIVE_JOB_NAME, async (job: Job) => {
    const candidates = await findLiveCandidateMatches();
    const runSummary: Array<{ matchId: string; matchName: string; action: string; error?: string }> = [];

    for (const match of candidates) {
      // Contest gate FIRST, before any provider API call -- the whole point is avoiding wasted
      // Cricbuzz/ESPN quota on matches nobody's live-competing in via a Contest.
      const hasContest = await hasActiveContestForMatch(match);
      if (!hasContest) {
        runSummary.push({ matchId: String(match._id), matchName: match.matchName, action: "skip-no-contest" });
        continue;
      }

      const isFootball = (match.cricbuzzMatchId ?? "").startsWith("espn:");
      let isLive = false;

      try {
        if (isFootball) {
          const espnId = (match.cricbuzzMatchId ?? "").replace(/^espn:/, "");
          const status = await fetchEspnMatchStatus(espnId);
          isLive = status.isLive;
        } else {
          const status = await fetchCricbuzzMatchStatus(String(match.cricbuzzMatchId));
          isLive = status.isLive;
        }
      } catch (err) {
        runSummary.push({ matchId: String(match._id), matchName: match.matchName, action: "skip-not-live", error: `status check failed: ${err instanceof Error ? err.message : String(err)}` });
        continue;
      }

      if (!isLive) {
        runSummary.push({ matchId: String(match._id), matchName: match.matchName, action: "skip-not-live" });
        continue;
      }

      try {
        if (isFootball) {
          await liveScoreFootballMatch(match);
        } else {
          await liveScoreCricketMatch(match);
        }
        runSummary.push({ matchId: String(match._id), matchName: match.matchName, action: "scored-live" });
      } catch (err) {
        // No isCompleted rollback needed here -- live scoring never sets isCompleted in the first
        // place, so there's nothing to roll back. A failure just means this match isn't updated
        // this tick; it's a normal candidate again on the very next 10-min tick.
        runSummary.push({ matchId: String(match._id), matchName: match.matchName, action: "error", error: err instanceof Error ? err.message : String(err) });
      }
    }

    job.attrs.data = {
      lastRunAt: new Date().toISOString(),
      candidates: candidates.length,
      results: runSummary,
    };
    await job.save();
  });
}
