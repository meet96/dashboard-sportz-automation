import SeriesSquad from "../models/SeriesSquad";
import EplTransferLog from "../models/EplTransferLog";
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

  // Every transfer this series has already logged, keyed by its natural (playerName, fromClub,
  // toClub) triple -- lets a re-run of this same check (the feed has no since-last-check cursor)
  // skip a transfer it's already recorded, rather than reporting it as "applied" again every time.
  const existingLogs = await EplTransferLog.find({ seriesId, leagueCode }).select("playerName fromClub toClub").lean();
  const loggedKeys = new Set(existingLogs.map((l) => `${l.playerName}|${l.fromClub}|${l.toClub}`));

  const applied: AppliedTransfer[] = [];
  const needsReview: NeedsReviewTransfer[] = [];
  let squadModified = false;

  for (const transfer of transfers) {
    const canonicalFromClub = resolveEplClub(transfer.fromClub);
    if (!canonicalFromClub || !clubsInSquad.has(canonicalFromClub)) continue;

    // Searches the WHOLE squad (every club, not just fromClub's own roster) for a confident name
    // match -- a squad re-pull can already reassign a player to their new club before this check
    // ever runs (an EPL-to-EPL move the source itself picked up), so scoping the search to just
    // fromClub's current roster misses them entirely. A player genuinely not found anywhere in the
    // squad -- most commonly because they left the tracked competition altogether and the source's
    // fresh pull simply dropped them -- has nothing actionable to report, so it's skipped outright
    // rather than padding out a "no confident match, check manually" list an admin can't act on.
    const scored = squad.players
      .map((p) => ({ player: p, score: playerNameMatchScore(p.playerName, transfer.playerName) }))
      .filter((s) => s.score >= TRANSFER_MATCH_CONFIDENT_THRESHOLD);

    if (scored.length === 0) continue;

    if (scored.length > 1) {
      needsReview.push({
        playerName: transfer.playerName,
        fromClub: canonicalFromClub,
        toClub: transfer.toClub,
        reason: `Ambiguous -- ${scored.length} squad players matched confidently.`,
      });
      continue;
    }

    const { player } = scored[0];
    let didSomething = false;

    // Only flip the squad doc's own transferredOut/transferredTo when the pull hasn't already
    // reflected the move -- if this player's current club already differs from canonicalFromClub
    // (the Nicolas Jackson case: an EPL-to-EPL move a fresh pull already picked up), there's
    // nothing to fix on the squad side, just a transfer worth logging for history/display.
    const playerCurrentClub = resolveEplClub(player.teamName) ?? player.teamName.trim();
    if (playerCurrentClub === canonicalFromClub && !player.transferredOut) {
      player.transferredOut = true;
      player.transferredTo = transfer.toClub;
      player.transferredAt = transfer.transferDate ? new Date(transfer.transferDate) : new Date();
      squadModified = true;
      didSomething = true;
    }

    // Durable record, independent of squad.players[].transferredOut -- a later "Pull Squad" run
    // replaces that whole array (silently resetting every flag), but this log is what the classic
    // team editor's swap picker and "transferred this window" banner read from, so it needs to
    // survive that.
    const key = `${player.playerName}|${canonicalFromClub}|${transfer.toClub}`;
    if (!loggedKeys.has(key)) {
      await EplTransferLog.create({
        seriesId,
        leagueCode,
        playerName: player.playerName,
        fromClub: canonicalFromClub,
        toClub: transfer.toClub,
        transferDate: transfer.transferDate ? new Date(transfer.transferDate) : new Date(),
        source: "auto",
      });
      loggedKeys.add(key);
      didSomething = true;
    }

    if (didSomething) {
      applied.push({ playerName: player.playerName, fromClub: canonicalFromClub, toClub: transfer.toClub });
    }
  }

  if (squadModified) {
    squad.markModified("players");
    await squad.save();
  }

  return { applied, needsReview };
}
