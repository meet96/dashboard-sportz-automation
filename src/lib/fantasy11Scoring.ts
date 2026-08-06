import Fantasy11Points from "../models/Fantasy11Points";

export interface TeamRawScore {
  teamId: string;
  userId: string;
  groupId: string | null;
  groupNames: string[];
  points: number;
  playerPoints: { playerName: string; points: number }[];
}

export interface RankedFantasy11Result extends TeamRawScore {
  rankPoints: number;
}

// Ranks one group's worth of raw team scores for a match (highest points = rank 1, ties share a
// rank) and upserts each into Fantasy11Points — the single source of truth the leaderboard reads
// from. Shared by both the cricbuzz auto-scoring route and manual point entry so the two stay
// behaviorally identical regardless of where the raw player points came from.
export async function rankAndSaveFantasy11Group(
  matchId: string,
  leagueCode: string,
  groupScores: TeamRawScore[]
): Promise<RankedFantasy11Result[]> {
  const sorted = [...groupScores].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    return a.userId.localeCompare(b.userId);
  });

  const participantCount = sorted.length;
  let lastPoints: number | null = null;
  let lastRankPosition = 0;
  const results: RankedFantasy11Result[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const row = sorted[i];
    const rankPosition = lastPoints !== null && row.points === lastPoints ? lastRankPosition : i + 1;
    const rankPoints = Math.max(participantCount - rankPosition, 0);
    lastPoints = row.points;
    lastRankPosition = rankPosition;

    await Fantasy11Points.findOneAndUpdate(
      { userId: row.userId, matchId, leagueCode, groupId: row.groupId },
      {
        $set: {
          groupId: row.groupId,
          groupNames: row.groupNames,
          rawPoints: row.points,
          rankPoints,
          playerPoints: row.playerPoints,
        },
      },
      { upsert: true, new: true }
    );

    results.push({ ...row, rankPoints });
  }
  return results;
}

// Applies the captain (2x) / vice-captain (1.5x) multiplier to a team's raw per-player points —
// the same post-processing score-fantasy11 does after computing points from a cricbuzz
// scorecard, factored out so manually-entered raw points get scored identically.
export function applyCaptainMultiplier(
  rawPlayerPoints: { playerName: string; points: number }[],
  captain: string,
  viceCaptain: string
): { playerName: string; points: number }[] {
  const captainKey = captain.trim().toLowerCase();
  const viceCaptainKey = viceCaptain.trim().toLowerCase();
  return rawPlayerPoints.map((pp) => {
    const key = pp.playerName.trim().toLowerCase();
    const isCaptain = captainKey && key === captainKey;
    const isViceCaptain = viceCaptainKey && key === viceCaptainKey;
    const multiplier = isCaptain ? 2 : isViceCaptain ? 1.5 : 1;
    return { playerName: pp.playerName, points: Math.round(pp.points * multiplier) };
  });
}
