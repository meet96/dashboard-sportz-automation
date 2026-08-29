import SeriesSquad from "../models/SeriesSquad";
import { fetchEplTransfers, resolveEplClub, playerNameMatchScore, TRANSFER_MATCH_CONFIDENT_THRESHOLD } from "../lib/eplTransfers";

export interface AppliedTransfer {
  playerName: string;
  fromClub: string;
  toClub: string;
}

export interface NeedsReviewTransfer {
  playerName: string;
  fromClub: string;
  toClub: string;
  reason: string;
}

export interface CheckEplTransfersResult {
  applied: AppliedTransfer[];
  needsReview: NeedsReviewTransfer[];
}

// Admin-triggered only (see dashboard-sportz's SeriesSquadTab.tsx "Check for Transfers" button,
// proxied here via POST /transfers/epl/check) -- there is no recurring job calling this today.
// Transfer windows close twice a year; an admin runs this once each time, after the window has
// genuinely closed, rather than a fixed calendar-date schedule (deadline day shifts by a day or
// two year to year). Structured as a plain service function (this repo's existing convention --
// see services/scoreFootball.ts etc.) so wiring it into an Agenda job later, if ever wanted, is a
// small addition rather than a rewrite.
export async function checkEplTransfers(seriesId: string, leagueCode: string): Promise<CheckEplTransfersResult> {
  const squad = await SeriesSquad.findOne({ seriesId, leagueCode });
  if (!squad) throw new Error("No squad data found for this series. Pull the squad first.");

  const transfers = await fetchEplTransfers();

  // Only clubs this squad actually has players for are worth checking -- everything else in the
  // global-ish transfer feed is noise for this series.
  const clubsInSquad = new Set(
    squad.players.map((p) => resolveEplClub(p.teamName) ?? p.teamName.trim()).filter(Boolean)
  );

  const applied: AppliedTransfer[] = [];
  const needsReview: NeedsReviewTransfer[] = [];

  for (const transfer of transfers) {
    const canonicalFromClub = resolveEplClub(transfer.fromClub);
    if (!canonicalFromClub || !clubsInSquad.has(canonicalFromClub)) continue;

    const candidates = squad.players.filter((p) => {
      if (p.transferredOut) return false; // already flagged, don't re-process
      const playerClub = resolveEplClub(p.teamName) ?? p.teamName.trim();
      return playerClub === canonicalFromClub;
    });

    const scored = candidates
      .map((p) => ({ player: p, score: playerNameMatchScore(p.playerName, transfer.playerName) }))
      .filter((s) => s.score >= TRANSFER_MATCH_CONFIDENT_THRESHOLD);

    if (scored.length === 1) {
      const { player } = scored[0];
      player.transferredOut = true;
      player.transferredTo = transfer.toClub;
      player.transferredAt = transfer.transferDate ? new Date(transfer.transferDate) : new Date();
      applied.push({ playerName: player.playerName, fromClub: canonicalFromClub, toClub: transfer.toClub });
    } else if (scored.length === 0 && candidates.length > 0) {
      // A transfer left this club, and we have players drafted from it, but couldn't confidently
      // match a name -- surface it rather than silently missing a real transfer.
      needsReview.push({
        playerName: transfer.playerName,
        fromClub: canonicalFromClub,
        toClub: transfer.toClub,
        reason: "No confident name match in this squad -- check manually.",
      });
    } else if (scored.length > 1) {
      needsReview.push({
        playerName: transfer.playerName,
        fromClub: canonicalFromClub,
        toClub: transfer.toClub,
        reason: `Ambiguous -- ${scored.length} squad players matched confidently.`,
      });
    }
  }

  if (applied.length > 0) {
    squad.markModified("players");
    await squad.save();
  }

  return { applied, needsReview };
}
