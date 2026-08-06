import assert from "node:assert";
import { calculatePlayerPoints, DEFAULT_WEIGHTS } from "../src/lib/cricbuzz";

function main() {
  // 55 runs (fifty bonus), 3 fours, 2 sixes, 2 wickets, 1 catch
  const points = calculatePlayerPoints(
    { runs: 55, fours: 3, sixes: 2, wickets: 2, catches: 1, runOuts: 0, stumpings: 0 },
    DEFAULT_WEIGHTS
  );
  // 55*1 + 3*2 + 2*5 + 25 (fifty bonus) + 2*25 (wickets) + 1*10 (catch)
  const expected = 55 + 6 + 10 + 25 + 50 + 10;
  assert.strictEqual(points, expected, `expected ${expected}, got ${points}`);
  console.log("PASS: smoke-cricbuzz-parse");
}

main();
