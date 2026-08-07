import mongoose from "mongoose";
import Series from "../models/Series";
import Contest from "../models/Contest";

interface MatchLike {
  _id: unknown;
  leagueCodes: string[];
  series?: string[] | null;
}

// Resolves whether a real player-created Contest exists for this match, gating live scoring.
// Match documents don't carry a seriesId directly (only series name strings + leagueCodes), so
// this first resolves the match's series name(s) to actual Series document ids, then checks for
// a Contest referencing one of those series ids (and this leagueCode). A Contest's `matchId` is
// only set for "advanced"-format (single-match-scoped) contests — when set, it must equal this
// match's _id; when unset, the contest spans the whole series and matches any match within it.
export async function hasActiveContestForMatch(match: MatchLike): Promise<boolean> {
  const seriesNames = (match.series ?? []).map((s) => (typeof s === "string" ? s.trim() : "")).filter(Boolean);
  if (seriesNames.length === 0 || match.leagueCodes.length === 0) return false;

  const seriesDocs = await Series.find({
    leagueCode: { $in: match.leagueCodes },
    name: { $in: seriesNames },
  }).select("_id").lean<{ _id: mongoose.Types.ObjectId }[]>();
  if (seriesDocs.length === 0) return false;

  const seriesIds = seriesDocs.map((s) => s._id);

  const matchId = String(match._id);
  const matchObjectId = mongoose.isValidObjectId(match._id) ? new mongoose.Types.ObjectId(matchId) : null;
  const contest = await Contest.findOne({
    seriesId: { $in: seriesIds },
    leagueCode: { $in: match.leagueCodes },
    $or: [{ matchId: null }, { matchId: { $exists: false } }, ...(matchObjectId ? [{ matchId: matchObjectId }] : [])],
  }).lean();

  if (!contest) return false;
  // Defensive re-check: a matchId-scoped contest must match this exact match (the $or above
  // already filters correctly, but this makes the "advanced-format, wrong match" exclusion explicit
  // and independently verifiable rather than relying solely on the query).
  if (contest.matchId && String(contest.matchId) !== matchId) return false;

  return true;
}
