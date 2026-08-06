import LeagueCode from "../models/LeagueCode";
import Series from "../models/Series";
import { isClassicShaped } from "./seriesFormat";

export interface ClassicScoringTarget {
  league: { code: string; name: string; gameType: string };
  // null = no seriesId/groupId scoping at all (Bucket A: leagues whose own gameType is
  // literally "classic" — every ClassicTeam doc for that leagueCode gets scored, exactly as
  // before this helper existed). Non-null = Bucket B: a fantasy11/football-gameType league
  // that has a classic-format group override for this match's series — only teams in the
  // overridden group(s), for that specific series, get scored.
  seriesId: string | null;
  groupIds: string[] | null;
}

interface MatchLike {
  leagueCodes: string[];
  series?: string[] | null;
}

/**
 * Determines which leagueCodes (and, where relevant, which series+groups within them) should
 * be scored classic-style for a given match.
 *
 * Bucket A (leagues whose own gameType === "classic") is intentionally left completely
 * unscoped — matching the pre-existing behavior of score-classic/route.ts. Adding seriesId
 * scoping there too would risk silently scoring zero teams for any classic league whose
 * ClassicTeam docs predate the seriesId backfill (only FOOTBALLCLASSIC was backfilled; see
 * audit-classic-scoring-scope.js). Bucket B only ever matches ClassicTeam docs saved after
 * Series.groupFormats existed, so there's no legacy-data mismatch risk there.
 */
export async function resolveClassicScoringTargets(match: MatchLike): Promise<ClassicScoringTarget[]> {
  const targets: ClassicScoringTarget[] = [];

  const classicLeagues = await LeagueCode.find({
    code: { $in: match.leagueCodes },
    gameType: "classic",
  }).lean();
  for (const league of classicLeagues) {
    targets.push({
      league: { code: league.code, name: league.name, gameType: league.gameType },
      seriesId: null,
      groupIds: null,
    });
  }

  const seriesNames = (match.series ?? []).map((s) => (typeof s === "string" ? s.trim() : "")).filter(Boolean);
  if (seriesNames.length > 0) {
    const otherLeagues = await LeagueCode.find({
      code: { $in: match.leagueCodes },
      gameType: { $in: ["fantasy11", "football", "advanced"] },
    }).lean();

    for (const league of otherLeagues) {
      const seriesDoc = await Series.findOne({ leagueCode: league.code, name: { $in: seriesNames } })
        .select("groupFormats")
        .lean();
      if (!seriesDoc) continue;

      const classicGroupIds = (seriesDoc.groupFormats ?? [])
        .filter((gf) => isClassicShaped(gf.format))
        .map((gf) => String(gf.groupId));
      if (classicGroupIds.length === 0) continue;

      targets.push({
        league: { code: league.code, name: league.name, gameType: league.gameType },
        seriesId: String(seriesDoc._id),
        groupIds: classicGroupIds,
      });
    }
  }

  return targets;
}

/** Builds the ClassicTeam.find() filter for a single target (unscoped for Bucket A, scoped for Bucket B). */
export function classicTeamFilterForTarget(target: ClassicScoringTarget): Record<string, unknown> {
  const filter: Record<string, unknown> = { leagueCode: target.league.code };
  if (target.groupIds) {
    filter.seriesId = target.seriesId;
    filter.groupId = { $in: target.groupIds };
  }
  return filter;
}
