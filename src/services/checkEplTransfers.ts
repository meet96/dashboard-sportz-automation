import SeriesSquad from "../models/SeriesSquad";
import EplTransferLog from "../models/EplTransferLog";
import { fetchEplTransfers, resolveEplClub, playerNameMatchScore, TRANSFER_MATCH_CONFIDENT_THRESHOLD } from "../lib/eplTransfers";

export interface LoggedTransfer {
  playerName: string;
  fromClub: string;
  toClub: string;
}

export interface CheckEplTransfersResult {
  logged: LoggedTransfer[];
}

// Admin-triggered only (see dashboard-sportz's SeriesSquadTab.tsx "Check for Transfers" button,
// proxied here via POST /transfers/epl/check) -- there is no recurring job calling this today.
// Transfer windows close twice a year; an admin runs this once each time, after the window has
// genuinely closed, rather than a fixed calendar-date schedule (deadline day shifts by a day or
// two year to year). Structured as a plain service function (this repo's existing convention --
// see services/scoreFootball.ts etc.) so wiring it into an Agenda job later, if ever wanted, is a
// small addition rather than a rewrite.
//
// Records every transfer relevant to this squad unconditionally -- there's no admin-facing
// "review and manually resolve" step anymore. Whether a given transfer is actually a currently
// pickable swap-in candidate is decided later, at swap time, by the mobile classic team editor
// cross-referencing this log against the live squad by name (see ClassicTeamEditorScreen.tsx) --
// a player it can't find under any club there just doesn't show up as an option. That's a strictly
// better place to make that call than here: the live squad can change (re-pulls, further
// transfers) after this log entry is written, and re-deciding "are they still real" at swap time
// instead of freezing a verdict into the log keeps it correct without needing to re-run this check.
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
  // skip a transfer it's already recorded, rather than logging it again every time.
  const existingLogs = await EplTransferLog.find({ seriesId, leagueCode }).select("playerName fromClub toClub").lean();
  const loggedKeys = new Set(existingLogs.map((l) => `${l.playerName}|${l.fromClub}|${l.toClub}`));

  const logged: LoggedTransfer[] = [];
  let squadModified = false;

  for (const transfer of transfers) {
    const canonicalFromClub = resolveEplClub(transfer.fromClub);
    if (!canonicalFromClub || !clubsInSquad.has(canonicalFromClub)) continue;

    // Searches the WHOLE squad (every club, not just fromClub's own roster) for a confident name
    // match -- a squad re-pull can already reassign a player to their new club before this check
    // ever runs (an EPL-to-EPL move the source itself picked up), so scoping the search to just
    // fromClub's current roster misses them. When exactly one confident match exists, the log uses
    // that squad player's own exact spelling (guarantees the mobile app's name-based
    // cross-reference against the live squad actually finds them); otherwise it falls back to the
    // feed's own spelling -- there's nothing better, and no squad match means the mobile side will
    // correctly treat them as not currently pickable regardless of exact spelling.
    const scored = squad.players
      .map((p) => ({ player: p, score: playerNameMatchScore(p.playerName, transfer.playerName) }))
      .filter((s) => s.score >= TRANSFER_MATCH_CONFIDENT_THRESHOLD);
    const playerName = scored.length === 1 ? scored[0].player.playerName : transfer.playerName;

    const key = `${playerName}|${canonicalFromClub}|${transfer.toClub}`;
    if (loggedKeys.has(key)) continue;

    await EplTransferLog.create({
      seriesId,
      leagueCode,
      playerName,
      fromClub: canonicalFromClub,
      toClub: transfer.toClub,
      transferDate: transfer.transferDate ? new Date(transfer.transferDate) : new Date(),
      source: "auto",
    });
    loggedKeys.add(key);
    logged.push({ playerName, fromClub: canonicalFromClub, toClub: transfer.toClub });

    // Best-effort side effect of logging, not a precondition for it: still flag the squad's own
    // player record when there's exactly one confident match still sitting under the old club --
    // keeps the reactive "your own pick needs a swap" detection (transferredInActive, mobile)
    // working for the common case where a re-pull hasn't happened yet.
    if (scored.length === 1) {
      const { player } = scored[0];
      const playerCurrentClub = resolveEplClub(player.teamName) ?? player.teamName.trim();
      if (playerCurrentClub === canonicalFromClub && !player.transferredOut) {
        player.transferredOut = true;
        player.transferredTo = transfer.toClub;
        player.transferredAt = transfer.transferDate ? new Date(transfer.transferDate) : new Date();
        squadModified = true;
      }
    }
  }

  if (squadModified) {
    squad.markModified("players");
    await squad.save();
  }

  return { logged };
}
