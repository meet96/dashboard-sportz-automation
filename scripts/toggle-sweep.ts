import "dotenv/config";
import Agenda from "agenda";
import { connectDB } from "../src/db";
import { JOB_NAME as SWEEP_JOB_NAME } from "../src/jobs/checkAndScoreMatches";

const VALID_JOB_NAMES = [SWEEP_JOB_NAME];

function parseArgs(argv: string[]): { mode: "--pause" | "--resume"; jobName: string } {
  const mode = argv[0];
  if (mode !== "--pause" && mode !== "--resume") {
    throw new Error("Usage: npx tsx scripts/toggle-sweep.ts --pause | --resume [--job <name>]");
  }
  const jobFlagIdx = argv.indexOf("--job");
  const jobName = jobFlagIdx !== -1 ? argv[jobFlagIdx + 1] : SWEEP_JOB_NAME;
  if (!jobName || !VALID_JOB_NAMES.includes(jobName)) {
    throw new Error(`--job must be one of: ${VALID_JOB_NAMES.join(", ")} (got: ${jobName ?? "<missing>"})`);
  }
  return { mode, jobName };
}

async function main() {
  let mode: "--pause" | "--resume";
  let jobName: string;
  try {
    ({ mode, jobName } = parseArgs(process.argv.slice(2)));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  await connectDB();
  const agenda = new Agenda({ db: { address: process.env.MONGODB_URI! } });

  // Agenda's MongoDB collection is initialized asynchronously (event-driven, not promise-based
  // from the constructor) — calling disable()/enable() before "ready" fires throws because
  // agenda's internal `_collection` is still undefined. Wait for it explicitly.
  await new Promise<void>((resolve) => agenda.once("ready", resolve));

  // Scoped to repeatInterval: { $exists: true } so this only ever touches the recurring job by
  // this name, never an in-flight one-time targeted run (which has no repeatInterval at all).
  const query = { name: jobName, repeatInterval: { $exists: true } };

  const affected =
    mode === "--pause" ? await agenda.disable(query) : await agenda.enable(query);

  console.log(
    `${mode === "--pause" ? "Paused" : "Resumed"} ${affected} job(s) matching "${jobName}" (recurring only).`
  );

  if (affected === 0) {
    console.log(
      "No matching recurring job found — has the automation service been started at least once (so agenda.every() has run)?"
    );
  }

  await agenda.stop().catch(() => {});
  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
