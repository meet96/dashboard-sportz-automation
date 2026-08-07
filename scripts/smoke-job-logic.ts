import assert from "node:assert";
import { decideMatchAction, decideForcedMatchAction, parseTargetRequest } from "../src/jobs/checkAndScoreMatches";

function main() {
  const now = Date.now();
  const startedRecently = new Date(now - 2 * 60 * 60 * 1000); // 2h ago

  assert.strictEqual(
    decideMatchAction({ date: startedRecently, cricbuzzMatchId: "12345" }, true, now),
    "score-cricket"
  );
  assert.strictEqual(
    decideMatchAction({ date: startedRecently, cricbuzzMatchId: "espn:999" }, true, now),
    "score-football"
  );
  assert.strictEqual(
    decideMatchAction({ date: startedRecently, cricbuzzMatchId: "12345" }, false, now),
    "skip-not-finished"
  );

  const startedLongAgo = new Date(now - 13 * 60 * 60 * 1000); // 13h ago, past the 12h cap
  assert.strictEqual(
    decideMatchAction({ date: startedLongAgo, cricbuzzMatchId: "12345" }, false, now),
    "stale"
  );

  // Finding 1: a match that IS reported finished but has been stuck for over 48h (e.g. scoring
  // throws every tick) must stop retrying — the absolute cap returns "stale" even though finished.
  const startedWayLongAgo = new Date(now - 49 * 60 * 60 * 1000); // 49h ago, past the 48h absolute cap
  assert.strictEqual(
    decideMatchAction({ date: startedWayLongAgo, cricbuzzMatchId: "12345" }, true, now),
    "stale"
  );
  assert.strictEqual(
    decideMatchAction({ date: startedWayLongAgo, cricbuzzMatchId: "espn:999" }, true, now),
    "stale"
  );
  // A finished match within the absolute cap (e.g. 24h to score successfully) must still score.
  const startedYesterday = new Date(now - 24 * 60 * 60 * 1000); // 24h ago, within the 48h cap
  assert.strictEqual(
    decideMatchAction({ date: startedYesterday, cricbuzzMatchId: "12345" }, true, now),
    "score-cricket"
  );

  // Finding 2: a finished cricket match reported no-result (abandoned/cancelled/walkover) must be
  // routed to "no-result" — never scored — regardless of how recently it started.
  assert.strictEqual(
    decideMatchAction({ date: startedRecently, cricbuzzMatchId: "12345" }, true, now, true),
    "no-result"
  );
  // no-result wins even past the absolute cap (resolve it rather than leave it stale).
  assert.strictEqual(
    decideMatchAction({ date: startedWayLongAgo, cricbuzzMatchId: "12345" }, true, now, true),
    "no-result"
  );

  // --- decideForcedMatchAction: no staleness concept at all, unlike decideMatchAction ---
  assert.strictEqual(
    decideForcedMatchAction({ cricbuzzMatchId: "12345" }, true, false),
    "score-cricket"
  );
  assert.strictEqual(
    decideForcedMatchAction({ cricbuzzMatchId: "espn:999" }, true, false),
    "score-football"
  );
  assert.strictEqual(
    decideForcedMatchAction({ cricbuzzMatchId: "12345" }, false, false),
    "skip-not-finished"
  );
  assert.strictEqual(
    decideForcedMatchAction({ cricbuzzMatchId: "12345" }, true, true),
    "no-result"
  );

  // --- parseTargetRequest: distinguishes a targeted request from the normal empty-data sweep ---
  assert.strictEqual(parseTargetRequest(undefined), null);
  assert.strictEqual(parseTargetRequest({}), null);
  assert.strictEqual(parseTargetRequest({ lastRunAt: "2026-01-01", candidates: 3, results: [] }), null); // looks like leftover sweep output, not a target request

  assert.deepStrictEqual(
    parseTargetRequest({ matchId: "68a1000000000000000000aa" }),
    { matchIds: ["68a1000000000000000000aa"], leagueCode: undefined, series: undefined }
  );
  assert.deepStrictEqual(
    parseTargetRequest({ matchIds: ["68a1000000000000000000aa", "68a1000000000000000000bb"] }),
    { matchIds: ["68a1000000000000000000aa", "68a1000000000000000000bb"], leagueCode: undefined, series: undefined }
  );
  // matchId and matchIds combined and deduped
  assert.deepStrictEqual(
    parseTargetRequest({ matchId: "68a1000000000000000000aa", matchIds: ["68a1000000000000000000aa", "68a1000000000000000000bb"] }),
    { matchIds: ["68a1000000000000000000aa", "68a1000000000000000000bb"], leagueCode: undefined, series: undefined }
  );
  assert.deepStrictEqual(
    parseTargetRequest({ leagueCode: "FANTASY11", series: "IPL2026" }),
    { matchIds: [], leagueCode: "FANTASY11", series: "IPL2026" }
  );
  // leagueCode alone (no series) is still a "targeted run" per parseTargetRequest -- the
  // both-required validation happens later in resolveTargetedMatches, reported as a not-found entry
  assert.deepStrictEqual(
    parseTargetRequest({ leagueCode: "FANTASY11" }),
    { matchIds: [], leagueCode: "FANTASY11", series: undefined }
  );

  // Finding (live scoring): a targeted match that's live (not finished, not no-result, isLive)
  // decides "scored-live" -- the Contest gate is checked separately by the job handler, not by
  // this pure decision function (it has no DB access).
  assert.strictEqual(
    decideForcedMatchAction({ cricbuzzMatchId: "12345" }, false, false, true),
    "scored-live"
  );
  assert.strictEqual(
    decideForcedMatchAction({ cricbuzzMatchId: "espn:999" }, false, false, true),
    "scored-live"
  );
  // Not live and not finished -> still just skip-not-finished, unchanged from before.
  assert.strictEqual(
    decideForcedMatchAction({ cricbuzzMatchId: "12345" }, false, false, false),
    "skip-not-finished"
  );
  // Finished takes priority over live (a match reported both finished AND briefly still flagged
  // live by a stale provider read would resolve to the authoritative finished outcome).
  assert.strictEqual(
    decideForcedMatchAction({ cricbuzzMatchId: "12345" }, true, false, true),
    "score-cricket"
  );

  console.log("PASS: smoke-job-logic");
}

main();
