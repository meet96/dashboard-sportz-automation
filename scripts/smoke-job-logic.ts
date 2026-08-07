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

  console.log("PASS: smoke-job-logic");
}

main();
