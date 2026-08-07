import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/db";

const JOB_NAME = "check-and-score-matches";
const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 30000;

interface ParsedArgs {
  matchId?: string;
  matchIds?: string[];
  leagueCode?: string;
  series?: string;
  url: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { url: "http://localhost:3001" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "--matchId":
        args.matchId = next();
        break;
      case "--matchIds":
        args.matchIds = next()
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case "--leagueCode":
        args.leagueCode = next();
        break;
      case "--series":
        args.series = next();
        break;
      case "--url":
        args.url = next();
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function validate(args: ParsedArgs): void {
  const hasIds = Boolean(args.matchId) || Boolean(args.matchIds?.length);
  const hasSeries = Boolean(args.leagueCode) || Boolean(args.series);
  if (hasSeries && (!args.leagueCode || !args.series)) {
    throw new Error("--leagueCode and --series must both be provided together");
  }
  if (!hasIds && !hasSeries) {
    throw new Error(
      "Provide --matchId <id>, --matchIds <id1,id2,...>, or --leagueCode <code> --series <name>"
    );
  }
}

function buildJobData(args: ParsedArgs): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (args.matchId) data.matchId = args.matchId;
  if (args.matchIds) data.matchIds = args.matchIds;
  if (args.leagueCode) data.leagueCode = args.leagueCode;
  if (args.series) data.series = args.series;
  return data;
}

async function submitJob(args: ParsedArgs): Promise<void> {
  const user = process.env.AGENDASH_USER ?? "admin";
  const password = process.env.AGENDASH_PASSWORD ?? "";
  const auth = Buffer.from(`${user}:${password}`).toString("base64");

  const res = await fetch(`${args.url}/admin/jobs/api/jobs/create`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify({
      jobName: JOB_NAME,
      jobSchedule: "now",
      jobData: buildJobData(args),
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to create job: ${res.status} ${text}`);
  }
}

interface AgendaJobDoc {
  _id: unknown;
  name: string;
  repeatInterval?: string;
  lastRunAt?: Date;
  lastFinishedAt?: Date;
  data?: unknown;
}

async function pollForResult(submittedAt: Date): Promise<AgendaJobDoc | null> {
  const db = mongoose.connection.db!;
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const job = await db
      .collection<AgendaJobDoc>("agendaJobs")
      .find({
        name: JOB_NAME,
        repeatInterval: { $exists: false },
        lastRunAt: { $gte: submittedAt },
      })
      .sort({ _id: -1 })
      .limit(1)
      .next();

    if (job?.lastFinishedAt) return job;

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  validate(args);

  const submittedAt = new Date();
  console.log(`Submitting targeted scoring job to ${args.url} ...`);
  await submitJob(args);

  await connectDB();
  let job: AgendaJobDoc | null;
  try {
    console.log("Waiting for result...");
    job = await pollForResult(submittedAt);
  } finally {
    await mongoose.disconnect();
  }

  if (!job) {
    console.log(
      `Timed out after ${POLL_TIMEOUT_MS / 1000}s waiting for a result. Check Agendash at ${args.url}/admin/jobs directly.`
    );
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify(job.data, null, 2));
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
