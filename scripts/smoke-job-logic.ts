import assert from "node:assert";
import { decideMatchAction } from "../src/jobs/checkAndScoreMatches";

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

  console.log("PASS: smoke-job-logic");
}

main();
