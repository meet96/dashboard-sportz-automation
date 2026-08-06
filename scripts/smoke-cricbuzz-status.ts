import "dotenv/config";
import assert from "node:assert";
import { fetchCricbuzzMatchStatus } from "../src/lib/cricbuzzStatus";

async function main() {
  const finished = await fetchCricbuzzMatchStatus("150993");
  console.log("150993:", finished);
  assert.strictEqual(finished.isFinished, true, "150993 should be finished (state=Abandon)");

  const notStarted = await fetchCricbuzzMatchStatus("151004");
  console.log("151004:", notStarted);
  assert.strictEqual(notStarted.isFinished, false, "151004 should not be finished (state=Preview)");

  console.log("PASS: smoke-cricbuzz-status");
}

main().catch((e) => {
  console.error("FAIL: smoke-cricbuzz-status", e);
  process.exit(1);
});
