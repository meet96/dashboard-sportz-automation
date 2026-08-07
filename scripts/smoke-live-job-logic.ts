import assert from "node:assert";
import { LIVE_JOB_NAME, defineCheckLiveMatchesJob } from "../src/jobs/checkLiveMatches";

function main() {
  assert.strictEqual(LIVE_JOB_NAME, "check-live-matches");
  assert.strictEqual(typeof defineCheckLiveMatchesJob, "function");

  // Confirm defineCheckLiveMatchesJob actually calls agenda.define with the right job name --
  // a fake minimal agenda double, no real Agenda/Mongo connection needed.
  let definedName: string | undefined;
  const fakeAgenda = {
    define: (name: string, _fn: unknown) => { definedName = name; },
  };
  defineCheckLiveMatchesJob(fakeAgenda as unknown as import("agenda").default);
  assert.strictEqual(definedName, LIVE_JOB_NAME);

  console.log("PASS: smoke-live-job-logic");
}

main();
