export type SeriesFormat = "classic" | "advanced" | "fantasy11" | "football";

interface GroupFormatEntry {
  groupId: string | { toString(): string };
  format: string;
}

interface SeriesLike {
  groupFormats?: GroupFormatEntry[] | null;
}

// A series can host groups playing different formats (e.g. one group drafts fantasy11-style,
// another classic-style) under one leagueCode/login. A group with no override in
// Series.groupFormats falls back to the leagueCode's own gameType — this keeps every existing
// series (none of which set groupFormats) behaving exactly as before.
export function resolveGroupFormat(
  series: SeriesLike | null | undefined,
  groupId: string | null | undefined,
  leagueGameType: string | null | undefined
): SeriesFormat {
  if (series && groupId) {
    const override = (series.groupFormats ?? []).find((gf) => String(gf.groupId) === String(groupId));
    if (override) return override.format as SeriesFormat;
  }
  return (leagueGameType as SeriesFormat) ?? "classic";
}

// Classic-shaped UI: 2 teams per user, no captain/VC, manual bonus/MOM. Covers both cricket
// classic and football-classic (they share the "classic" gameType, differentiated separately
// by lib/leagueType.ts's isFootballLeague()).
export function isClassicShaped(format: SeriesFormat | string | null | undefined): boolean {
  return format === "classic";
}

// Fantasy-shaped UI: 1 team per user per match, captain/vice-captain multipliers.
// "advanced" (the original, pre-rebrand cricket gameType) uses the identical mechanics to
// "fantasy11" and shares its whole drafting/scoring pipeline — treated as fantasy-shaped too.
export function isFantasyShaped(format: SeriesFormat | string | null | undefined): boolean {
  return format === "fantasy11" || format === "football" || format === "advanced";
}

interface PartitionSeries extends SeriesLike {
  leagueCode: string;
}

interface PartitionGroup {
  _id: string;
}

export interface FormatPartitionBucket<S, G> {
  seriesItems: S[];
  userGroups: G[];
}

export interface FormatPartition<S, G> {
  classic: FormatPartitionBucket<S, G>;
  fantasy: FormatPartitionBucket<S, G>;
}

// Splits a user's (series, group) combinations under one league into a classic-shaped bucket
// and a fantasy-shaped bucket, driven entirely by resolveGroupFormat. Used by the dashboard's
// teams tab to decide whether the user needs a single team-drafting panel (the common case —
// every group resolves to one shape) or a format picker (a user's groups span both shapes
// under the same leagueCode, e.g. a "Dream 11" group + a "Wolfpack" group sharing one login).
export function partitionSeriesAndGroupsByFormat<S extends PartitionSeries, G extends PartitionGroup>(
  seriesItems: S[],
  userGroups: G[],
  leagueCode: string,
  leagueGameType: string | null | undefined
): FormatPartition<S, G> {
  const leagueSeries = seriesItems.filter((s) => s.leagueCode === leagueCode);

  const classicSeries: S[] = [];
  const fantasySeries: S[] = [];
  const classicGroupIds = new Set<string>();
  const fantasyGroupIds = new Set<string>();

  for (const series of leagueSeries) {
    let seriesHasClassic = false;
    let seriesHasFantasy = false;
    for (const group of userGroups) {
      const format = resolveGroupFormat(series, group._id, leagueGameType);
      if (isClassicShaped(format)) {
        seriesHasClassic = true;
        classicGroupIds.add(group._id);
      }
      if (isFantasyShaped(format)) {
        seriesHasFantasy = true;
        fantasyGroupIds.add(group._id);
      }
    }
    if (seriesHasClassic) classicSeries.push(series);
    if (seriesHasFantasy) fantasySeries.push(series);
  }

  return {
    classic: { seriesItems: classicSeries, userGroups: userGroups.filter((g) => classicGroupIds.has(g._id)) },
    fantasy: { seriesItems: fantasySeries, userGroups: userGroups.filter((g) => fantasyGroupIds.has(g._id)) },
  };
}

// Given a specific (seriesId, groupId) pair a team panel is about to save into, tells you which
// shape it resolves to under this league — used to build an isSeriesGroupAllowed validator.
export function seriesGroupResolvesTo<S extends PartitionSeries>(
  seriesItems: S[],
  seriesId: string,
  groupId: string | null,
  leagueCode: string,
  leagueGameType: string | null | undefined
): SeriesFormat {
  const series = seriesItems.find((s) => s.leagueCode === leagueCode && String((s as unknown as { _id: string })._id) === String(seriesId));
  return resolveGroupFormat(series, groupId, leagueGameType);
}
