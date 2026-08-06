import "dotenv/config";
import assert from "node:assert";
import { connectDB } from "../src/db";
import Match from "../src/models/Match";
import ClassicTeam from "../src/models/ClassicTeam";
import ClassicPoints from "../src/models/ClassicPoints";
import ScoringConfig from "../src/models/ScoringConfig";
import LeagueCode from "../src/models/LeagueCode";
import Series from "../src/models/Series";
import User from "../src/models/User";
import Fantasy11Team from "../src/models/Fantasy11Team";
import Fantasy11Points from "../src/models/Fantasy11Points";
import Group from "../src/models/Group";

async function main() {
  await connectDB();
  const models = { Match, ClassicTeam, ClassicPoints, ScoringConfig, LeagueCode, Series, User, Fantasy11Team, Fantasy11Points, Group };
  for (const [name, Model] of Object.entries(models)) {
    const count = await (Model as typeof Match).countDocuments();
    assert.ok(count >= 0, `${name} query failed`);
    console.log(`${name}: ${count} documents`);
  }
  console.log("PASS: smoke-models");
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL: smoke-models", e);
  process.exit(1);
});
