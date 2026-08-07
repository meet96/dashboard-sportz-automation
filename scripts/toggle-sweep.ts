import "dotenv/config";
import Agenda from "agenda";
import { connectDB } from "../src/db";

const JOB_NAME = "check-and-score-matches";

async function main() {
  const mode = process.argv[2];
  if (mode !== "--pause" && mode !== "--resume") {
    console.error("Usage: npx tsx scripts/toggle-sweep.ts --pause | --resume");
    process.exitCode = 1;
    return;
  }

  await connectDB();
  const agenda = new Agenda({ db: { address: process.env.MONGODB_URI! } });

  // Agenda's MongoDB collection is initialized asynchronously (event-driven, not promise-based
  // from the constructor) — calling disable()/enable() before "ready" fires throws because
  // agenda's internal `_collection` is still undefined. Wait for it explicitly.
  await new Promise<void>((resolve) => agenda.once("ready", resolve));

  // Scoped to repeatInterval: { $exists: true } so this only ever touches the recurring sweep job,
  // never an in-flight one-time targeted run (which has no repeatInterval at all).
  const query = { name: JOB_NAME, repeatInterval: { $exists: true } };

  const affected =
    mode === "--pause" ? await agenda.disable(query) : await agenda.enable(query);

  console.log(
    `${mode === "--pause" ? "Paused" : "Resumed"} ${affected} job(s) matching "${JOB_NAME}" (recurring only).`
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
  process.exitCode = 1;
});
