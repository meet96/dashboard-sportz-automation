import "dotenv/config";
import assert from "node:assert";
import { fetchEspnMatchStatus } from "../src/lib/espnStatus";

async function main() {
  const notPlayed = await fetchEspnMatchStatus("401879301");
  console.log("401879301:", notPlayed);
  assert.strictEqual(notPlayed.completed, false, "401879301 should not be completed yet (state=pre)");
  assert.strictEqual(notPlayed.isLive, false, "401879301 should not be live (state=pre)");

  console.log("PASS: smoke-espn-status");
}

main().catch((e) => {
  console.error("FAIL: smoke-espn-status", e);
  process.exit(1);
});
