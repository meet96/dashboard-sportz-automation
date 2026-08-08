import type { Job } from "agenda";
import mongoose from "mongoose";
import Match, { IMatch } from "../models/Match";
import LeagueCode from "../models/LeagueCode";
import { fetchCricbuzzMatchStatus } from "../lib/cricbuzzStatus";
import { fetchEspnMatchStatus } from "../lib/espnStatus";
import { scoreClassicMatch } from "../services/scoreClassic";
import { scoreFantasy11Match } from "../services/scoreFantasy11";
import { scoreFootballMatch } from "../services/scoreFootball";
import { scoreFootballClassicMatchService } from "../services/scoreFootballClassic";
import { resolveClassicScoringTargets } from "../lib/resolveClassicScoringTargets";
import { hasActiveContestForMatch } from "../lib/hasActiveContestForMatch";

export const JOB_NAME = "check-and-score-matches";
const STALE_CAP_MS = 12 * 60 * 60 * 1000; // 12h past start, never reported finished -> stop auto-retrying
// Absolute ceiling: regardless of the provider's reported status, stop retrying a match more than
// 48h past its start time. This bounds the "finished but the scoring call throws every tick" case
// (missing ScoringConfig, a name-matching bug, provider outage) which the 12h cap above does NOT
// catch, because that cap only fires when a match is still *not finished*. Only applies to the
// recurring sweep's own candidates -- a manually targeted run (Task 1's new capability) always
// bypasses both caps, since a human explicitly asked for that match regardless of its age.
const ABSOLUTE_CAP_MS = 48 * 60 * 60 * 1000;

export type MatchAction =
  | "score-cricket"
  | "score-football"
  | "skip-not-finished"
  | "stale"
  | "no-result"
  | "not-found"
  | "scored-live"
  | "skip-no-contest";

// Pure decision function — no I/O — so it's unit-testable in isolation from the DB/network calls
// that determine `isFinished`/`isNoResult`/`nowMs`. Used by the recurring sweep only.
export function decideMatchAction(
  match: { date: Date; cricbuzzMatchId?: string | null },
  isFinished: boolean,
  nowMs: number,
  isNoResult: boolean = false,
  isLive: boolean = false
): MatchAction {
  const isFootball = (match.cricbuzzMatchId ?? "").startsWith("espn:");
  const startMs = new Date(match.date).getTime();
  const pastStale = nowMs - startMs > STALE_CAP_MS;
  const pastAbsoluteCap = nowMs - startMs > ABSOLUTE_CAP_MS;

  // Terminal-but-no-play (abandoned/cancelled/no-result/walkover): resolve as no-result instead of
  // scoring an empty scorecard. Cricket only; football never sets isNoResult here. Checked first so
  // a genuinely no-result match is always resolved, even if it's also past the absolute cap.
  if (isNoResult) return "no-result";
  // Wider absolute ceiling: applies whether or not the provider reports the match finished or live,
  // so a finished-but-perpetually-failing (or stuck-live) match eventually stops burning API quota.
  if (pastAbsoluteCap) return "stale";
  if (isFinished) return isFootball ? "score-football" : "score-cricket";
  // Checked before the 12h soft-stale cap so a genuinely long-running live match (e.g. a Test)
  // keeps getting live-scored past 12h, up to the 48h absolute cap above.
  if (isLive) return "scored-live";
  if (pastStale) return "stale";
  return "skip-not-finished";
}

// Same dispatch logic as decideMatchAction, but with no staleness concept at all -- used for
// manually-targeted matches, where a human explicitly asked for this one regardless of its age.
export function decideForcedMatchAction(
  match: { cricbuzzMatchId?: string | null },
  isFinished: boolean,
  isNoResult: boolean = false,
  isLive: boolean = false
): Exclude<MatchAction, "stale" | "not-found" | "skip-no-contest"> {
  if (isNoResult) return "no-result";
  if (isFinished) {
    const isFootball = (match.cricbuzzMatchId ?? "").startsWith("espn:");
    return isFootball ? "score-football" : "score-cricket";
  }
  if (isLive) return "scored-live";
  return "skip-not-finished";
}

interface TargetRequest {
  matchIds: string[];
  leagueCode?: string;
  series?: string;
}

// Reads job.attrs.data (as submitted via Agendash's Create Job form or the CLI wrapper) and
// determines whether this run is targeted. Returns null for the normal recurring-sweep case (no
// data, or data that specifies neither ids nor a league+series pair).
export function parseTargetRequest(data: unknown): TargetRequest | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;

  const ids = new Set<string>();
  if (typeof d.matchId === "string" && d.matchId.trim()) ids.add(d.matchId.trim());
  if (Array.isArray(d.matchIds)) {
    for (const id of d.matchIds) {
      if (typeof id === "string" && id.trim()) ids.add(id.trim());
    }
  }

  const leagueCode = typeof d.leagueCode === "string" && d.leagueCode.trim() ? d.leagueCode.trim() : undefined;
  const series = typeof d.series === "string" && d.series.trim() ? d.series.trim() : undefined;

  if (ids.size === 0 && !leagueCode && !series) return null;

  return { matchIds: [...ids], leagueCode, series };
}

interface TargetResolution {
  matches: IMatch[];
  notFound: Array<{ id: string; reason: string }>;
}

// Resolves a TargetRequest into actual Match documents, bypassing every recurring-sweep filter
// (isCompleted/noResult/date) -- a targeted run considers a match regardless of its current status.
async function resolveTargetedMatches(target: TargetRequest): Promise<TargetResolution> {
  const notFound: Array<{ id: string; reason: string }> = [];
  const matchMap = new Map<string, IMatch>();

  if (target.matchIds.length > 0) {
    const validIds = target.matchIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
    for (const id of target.matchIds) {
      if (!mongoose.Types.ObjectId.isValid(id)) notFound.push({ id, reason: "invalid match id format" });
    }
    if (validIds.length > 0) {
      const found = await Match.find({ _id: { $in: validIds } });
      const foundIds = new Set(found.map((m) => String(m._id)));
      for (const m of found) matchMap.set(String(m._id), m);
      for (const id of validIds) {
        if (!foundIds.has(id)) notFound.push({ id, reason: "no match found with this id" });
      }
    }
  }

  if (target.leagueCode || target.series) {
    if (!target.leagueCode || !target.series) {
      notFound.push({
        id: `${target.leagueCode ?? "?"}/${target.series ?? "?"}`,
        reason: "leagueCode and series must both be provided together",
      });
    } else {
      const seriesMatches = await Match.find({
        leagueCodes: target.leagueCode,
        series: target.series,
      });
      if (seriesMatches.length === 0) {
        notFound.push({
          id: `${target.leagueCode}/${target.series}`,
          reason: "no matches found for this leagueCode+series combination",
        });
      }
      for (const m of seriesMatches) matchMap.set(String(m._id), m);
    }
  }

  return { matches: [...matchMap.values()], notFound };
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
    // Capture the submitted data before this function overwrites job.attrs.data with results below.
    const target = parseTargetRequest(job.attrs.data);
    const isTargetedRun = target !== null;

    const runSummary: Array<{ matchId: string; matchName: string; action: MatchAction; error?: string }> = [];
    let candidates: IMatch[];

    if (isTargetedRun) {
      const resolution = await resolveTargetedMatches(target!);
      candidates = resolution.matches;
      for (const nf of resolution.notFound) {
        runSummary.push({ matchId: nf.id, matchName: "(unknown)", action: "not-found", error: nf.reason });
      }
    } else {
      candidates = await findCandidateMatches();
    }

    for (const match of candidates) {
      const isFootball = (match.cricbuzzMatchId ?? "").startsWith("espn:");
      let isFinished = false;
      let isNoResult = false;
      let isLive = false;

      try {
        if (isFootball) {
          const espnId = (match.cricbuzzMatchId ?? "").replace(/^espn:/, "");
          const status = await fetchEspnMatchStatus(espnId);
          isFinished = status.completed;
          isLive = status.isLive;
        } else {
          const status = await fetchCricbuzzMatchStatus(String(match.cricbuzzMatchId));
          isFinished = status.isFinished;
          isNoResult = status.isNoResult;
          isLive = status.isLive;
        }
      } catch (err) {
        runSummary.push({ matchId: String(match._id), matchName: match.matchName, action: "skip-not-finished", error: `status check failed: ${err instanceof Error ? err.message : String(err)}` });
        continue;
      }

      let action = isTargetedRun
        ? decideForcedMatchAction(match, isFinished, isNoResult, isLive)
        : decideMatchAction(match, isFinished, Date.now(), isNoResult, isLive);

      // Live scoring (targeted runs only -- the recurring sweep has no live concept) is further
      // gated on a real Contest existing, checked only when actually needed (not on every
      // candidate) to keep this cheap for the common finished/not-finished cases.
      if (action === "scored-live") {
        const hasContest = await hasActiveContestForMatch(match);
        if (!hasContest) action = "skip-no-contest";
      }

      if (action === "no-result") {
        // Terminal, but no actual play happened (abandoned/cancelled/no-result/walkover). Mark the
        // match resolved exactly as a human admin would — noResult: true + isCompleted: true — and
        // never run a scorer, which would otherwise upsert bogus 0-point rows for every real team.
        await Match.findByIdAndUpdate(match._id, { noResult: true, isCompleted: true });
        runSummary.push({ matchId: String(match._id), matchName: match.matchName, action });
        continue;
      }

      if (action === "skip-not-finished" || action === "stale" || action === "skip-no-contest") {
        runSummary.push({ matchId: String(match._id), matchName: match.matchName, action });
        continue;
      }

      if (action === "scored-live") {
        try {
          if (isFootball) {
            const leagues = await LeagueCode.find({ code: { $in: match.leagueCodes } }).lean();
            if (leagues.some((l) => l.gameType === "football")) {
              await scoreFootballMatch(String(match._id), { allowIncomplete: true });
            }
            if (leagues.some((l) => l.gameType === "classic" && (/football/i.test(l.code) || /football/i.test(l.name)))) {
              await scoreFootballClassicMatchService(String(match._id));
            }
          } else {
            const classicTargets = await resolveClassicScoringTargets(match);
            if (classicTargets.length > 0) {
              await scoreClassicMatch(String(match._id), { allowIncomplete: true });
            }
            const leagues = await LeagueCode.find({ code: { $in: match.leagueCodes } }).lean();
            if (leagues.some((l) => l.gameType === "fantasy11" || l.gameType === "advanced")) {
              await scoreFantasy11Match(String(match._id), { allowIncomplete: true });
            }
          }
          // No isCompleted write here -- live scoring never marks a match complete.
          runSummary.push({ matchId: String(match._id), matchName: match.matchName, action });
        } catch (err) {
          runSummary.push({ matchId: String(match._id), matchName: match.matchName, action, error: err instanceof Error ? err.message : String(err) });
        }
        continue;
      }

      try {
        await Match.findByIdAndUpdate(match._id, { isCompleted: true, noResult: false });
        if (action === "score-cricket") {
          await scoreCricketMatch(match);
        } else {
          await scoreFootballMatchByType(match);
        }
        runSummary.push({ matchId: String(match._id), matchName: match.matchName, action });
      } catch (err) {
        // Roll isCompleted back to false so this match remains (or becomes again) a candidate
        // on the next sweep tick. Without this, a transient scoring failure permanently strands the
        // match. Safe to redo: the scoring services are idempotent (upsert-keyed by {teamId,
        // matchId} etc.), so retrying both calls next time is harmless even if one already
        // succeeded. For a targeted run this simply means the operator can just re-trigger it.
        await Match.findByIdAndUpdate(match._id, { isCompleted: false });
        runSummary.push({ matchId: String(match._id), matchName: match.matchName, action, error: err instanceof Error ? err.message : String(err) });
      }
    }

    job.attrs.data = {
      lastRunAt: new Date().toISOString(),
      mode: isTargetedRun ? "targeted" : "sweep",
      requested: isTargetedRun ? { matchIds: target!.matchIds, leagueCode: target!.leagueCode, series: target!.series } : undefined,
      candidates: candidates.length,
      results: runSummary,
    };
    await job.save();
  });
}
