import "dotenv/config";
import assert from "node:assert";
import mongoose from "mongoose";
import { connectDB } from "../src/db";
import Series from "../src/models/Series";
import Contest from "../src/models/Contest";
import { hasActiveContestForMatch } from "../src/lib/hasActiveContestForMatch";

const TEST_LEAGUE = "SMOKE_TEST_LEAGUE";
const TEST_SERIES_NAME = "Smoke Test Series 2026";

async function main() {
  await connectDB();

  const series = await Series.create({
    name: TEST_SERIES_NAME,
    leagueCode: TEST_LEAGUE,
    year: 2026,
    groupIds: [],
  });

  try {
    const matchWithoutContest = { _id: new mongoose.Types.ObjectId(), leagueCodes: [TEST_LEAGUE], series: [TEST_SERIES_NAME] };
    assert.strictEqual(await hasActiveContestForMatch(matchWithoutContest), false, "no contest yet -> false");

    const seriesWideContest = await Contest.create({
      name: "Smoke Test Contest",
      joinCode: "SMOKE01",
      seriesId: series._id,
      leagueCode: TEST_LEAGUE,
      internalGroupId: new mongoose.Types.ObjectId(),
      internalGroupName: "Smoke Internal Group",
      createdByEmail: "smoke-test@example.com",
    });

    try {
      assert.strictEqual(await hasActiveContestForMatch(matchWithoutContest), true, "series-wide contest -> true for any match in the series");

      const otherLeagueMatch = { _id: new mongoose.Types.ObjectId(), leagueCodes: ["SOME_OTHER_LEAGUE"], series: [TEST_SERIES_NAME] };
      assert.strictEqual(await hasActiveContestForMatch(otherLeagueMatch), false, "different leagueCode -> false");

      // Advanced-format: matchId-scoped contest for a specific match should NOT match a different match
      const specificMatchId = new mongoose.Types.ObjectId();
      const scopedContest = await Contest.create({
        name: "Smoke Test Scoped Contest",
        joinCode: "SMOKE02",
        seriesId: series._id,
        leagueCode: TEST_LEAGUE,
        internalGroupId: new mongoose.Types.ObjectId(),
        internalGroupName: "Smoke Internal Group 2",
        createdByEmail: "smoke-test@example.com",
        matchId: specificMatchId,
      });
      try {
        const specificMatch = { _id: specificMatchId, leagueCodes: [TEST_LEAGUE], series: [TEST_SERIES_NAME] };
        assert.strictEqual(await hasActiveContestForMatch(specificMatch), true, "matchId-scoped contest matches its own match");
      } finally {
        await Contest.findByIdAndDelete(scopedContest._id);
      }
    } finally {
      await Contest.findByIdAndDelete(seriesWideContest._id);
    }
  } finally {
    await Series.findByIdAndDelete(series._id);
    await mongoose.disconnect();
  }

  console.log("PASS: smoke-contest-check");
}

main().catch(async (e) => {
  console.error("FAIL: smoke-contest-check", e);
  process.exit(1);
});
