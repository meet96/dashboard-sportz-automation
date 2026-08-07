import "dotenv/config";
import assert from "node:assert";
import { fetchCricbuzzMatchStatus } from "../src/lib/cricbuzzStatus";

async function main() {
  const finished = await fetchCricbuzzMatchStatus("150993");
  console.log("150993:", finished);
  assert.strictEqual(finished.isFinished, true, "150993 should be finished (state=Abandon)");
  // state=Abandon is a no-play terminal state -> must be flagged no-result (never scored).
  assert.strictEqual(finished.isNoResult, true, "150993 should be no-result (state=Abandon)");
  assert.strictEqual(finished.isLive, false, "150993 should not be live (terminal)");

  // 151004 was "Preview" (not started) at original design time; re-checked during Task 2
  // implementation and found to have progressed to "In Progress" (genuinely live, real data) --
  // used here as the live fixture instead. isFinished/isNoResult assertions below hold regardless
  // of which of those two states it's actually in.
  const live = await fetchCricbuzzMatchStatus("151004");
  console.log("151004:", live);
  assert.strictEqual(live.isFinished, false, "151004 should not be finished");
  assert.strictEqual(live.isNoResult, false, "151004 should not be no-result");
  assert.strictEqual(live.isLive, true, "151004 should be live (state=In Progress) -- if this now fails because the match has since finished, that's expected drift: re-pick a fresh in-progress match id from the real DB and update this assertion");

  // Fresh not-started fixture found during Task 2 implementation (state="Upcoming" -- a real
  // Cricbuzz not-yet-started state not covered by the original "Preview"/"Toss" assumption,
  // discovered via this exact live check and added to NOT_STARTED_STATES as a result).
  const notStarted = await fetchCricbuzzMatchStatus("151015");
  console.log("151015:", notStarted);
  assert.strictEqual(notStarted.isFinished, false, "151015 should not be finished (state=Upcoming)");
  assert.strictEqual(notStarted.isNoResult, false, "151015 should not be no-result (state=Upcoming)");
  assert.strictEqual(notStarted.isLive, false, "151015 should not be live (state=Upcoming, not yet started) -- if this now fails because the match has since started, re-pick a fresh not-yet-started match id from the real DB and update this assertion");

  console.log("PASS: smoke-cricbuzz-status");
}

main().catch((e) => {
  console.error("FAIL: smoke-cricbuzz-status", e);
  process.exit(1);
});
