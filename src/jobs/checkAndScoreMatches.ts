import type { Job } from "agenda";
import Match, { IMatch } from "../models/Match";
import LeagueCode from "../models/LeagueCode";
import { fetchCricbuzzMatchStatus } from "../lib/cricbuzzStatus";
import { fetchEspnMatchStatus } from "../lib/espnStatus";
import { scoreClassicMatch } from "../services/scoreClassic";
import { scoreFantasy11Match } from "../services/scoreFantasy11";
import { scoreFootballMatch } from "../services/scoreFootball";
import { scoreFootballClassicMatchService } from "../services/scoreFootballClassic";
import { resolveClassicScoringTargets } from "../lib/resolveClassicScoringTargets";

export const JOB_NAME = "check-and-score-matches";
const STALE_CAP_MS = 12 * 60 * 60 * 1000; // 12h past start with no resolution -> stop auto-retrying

export type MatchAction = "score-cricket" | "score-football" | "skip-not-finished" | "stale";

// Pure decision function — no I/O — so it's unit-testable in isolation from the DB/network calls
// that determine `isFinished`/`nowMs`.
export function decideMatchAction(
  match: { date: Date; cricbuzzMatchId?: string | null },
  isFinished: boolean,
  nowMs: number
): MatchAction {
  const isFootball = (match.cricbuzzMatchId ?? "").startsWith("espn:");
  const startMs = new Date(match.date).getTime();
  const pastStale = nowMs - startMs > STALE_CAP_MS;

  if (isFinished) return isFootball ? "score-football" : "score-cricket";
  if (pastStale) return "stale";
  return "skip-not-finished";
}

async function findCandidateMatches(): Promise<IMatch[]> {
  return Match.find({
    isCompleted: false,
    noResult: false,
    date: { $lte: new Date() },
    cricbuzzMatchId: { $exists: true, $ne: null },
  })
    .limit(50)
    .exec();
}

async function scoreCricketMatch(match: IMatch) {
  const results: Record<string, unknown> = {};
  const leagues = await LeagueCode.find({ code: { $in: match.leagueCodes } }).lean();
  const hasFantasy = leagues.some((l) => l.gameType === "fantasy11" || l.gameType === "advanced");
  const classicTargets = await resolveClassicScoringTargets(match);

  if (classicTargets.length > 0) {
    results.classic = await scoreClassicMatch(String(match._id));
  }
  if (hasFantasy) {
    results.fantasy11 = await scoreFantasy11Match(String(match._id));
  }
  return results;
}

async function scoreFootballMatchByType(match: IMatch) {
  const results: Record<string, unknown> = {};
  const leagues = await LeagueCode.find({ code: { $in: match.leagueCodes } }).lean();
  const hasFootball = leagues.some((l) => l.gameType === "football");
  const hasFootballClassic = leagues.some((l) => l.gameType === "classic" && (/football/i.test(l.code) || /football/i.test(l.name)));

  if (hasFootball) {
    results.football = await scoreFootballMatch(String(match._id));
  }
  if (hasFootballClassic) {
    results.footballClassic = await scoreFootballClassicMatchService(String(match._id));
  }
  return results;
}

export function defineCheckAndScoreJob(agenda: import("agenda").default) {
  agenda.define(JOB_NAME, async (job: Job) => {
    const candidates = await findCandidateMatches();
    const runSummary: Array<{ matchId: string; matchName: string; action: MatchAction; error?: string }> = [];

    for (const match of candidates) {
      const isFootball = (match.cricbuzzMatchId ?? "").startsWith("espn:");
      let isFinished = false;

      try {
        if (isFootball) {
          const espnId = (match.cricbuzzMatchId ?? "").replace(/^espn:/, "");
          const status = await fetchEspnMatchStatus(espnId);
          isFinished = status.completed;
        } else {
          const status = await fetchCricbuzzMatchStatus(String(match.cricbuzzMatchId));
          isFinished = status.isFinished;
        }
      } catch (err) {
        runSummary.push({ matchId: String(match._id), matchName: match.matchName, action: "skip-not-finished", error: `status check failed: ${err instanceof Error ? err.message : String(err)}` });
        continue;
      }

      const action = decideMatchAction(match, isFinished, Date.now());

      if (action === "skip-not-finished" || action === "stale") {
        runSummary.push({ matchId: String(match._id), matchName: match.matchName, action });
        continue;
      }

      try {
        await Match.findByIdAndUpdate(match._id, { isCompleted: true });
        if (action === "score-cricket") {
          await scoreCricketMatch(match);
        } else {
          await scoreFootballMatchByType(match);
        }
        runSummary.push({ matchId: String(match._id), matchName: match.matchName, action });
      } catch (err) {
        runSummary.push({ matchId: String(match._id), matchName: match.matchName, action, error: err instanceof Error ? err.message : String(err) });
      }
    }

    job.attrs.data = { lastRunAt: new Date().toISOString(), candidates: candidates.length, results: runSummary };
    await job.save();
  });
}
