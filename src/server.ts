import "dotenv/config";
import express from "express";
import Agenda from "agenda";
import Agendash from "agendash";
import basicAuth from "express-basic-auth";
import { scoreRoutes } from "./routes/scoreRoutes";
import { defineCheckAndScoreJob, JOB_NAME } from "./jobs/checkAndScoreMatches";
import { connectDB } from "./db";

export const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Agendash ops UI, protected by basic auth. Mounted BEFORE scoreRoutes: scoreRoutes'
// router applies `requireApiKey` unconditionally to every request that reaches it (it has
// no path restriction of its own, and scoreRoutes is itself mounted at "/"), so if this were
// registered after scoreRoutes, requests to /admin/jobs would be intercepted and rejected by
// requireApiKey (a 401 with a JSON "Missing Authorization: Bearer <key> header" body and no
// WWW-Authenticate header) before ever reaching basicAuth/Agendash below. Confirmed via curl
// during manual verification.
//
// `agenda` (declared below) is undefined until startAgenda() resolves, so this must check it
// at REQUEST time rather than mounting Agendash(agenda) at module scope — the latter would
// capture `undefined` permanently (or throw) during the boot window before startAgenda()
// finishes. See the `agenda` export below for why it can't be a module-scope const.
//
// Agendash(agenda) builds an entire Express sub-app on every call (static file serving,
// body-parser, API routes), so it's memoized here the first time `agenda` is truthy rather
// than rebuilt per request — a single page load fans out into several requests otherwise.
let agendashMiddleware: ReturnType<typeof Agendash> | undefined;

app.use(
  "/admin/jobs",
  basicAuth({
    users: { [process.env.AGENDASH_USER ?? "admin"]: process.env.AGENDASH_PASSWORD ?? "" },
    challenge: true,
  }),
  (req, res, next) => {
    if (!agenda) {
      res.status(503).json({ error: "Agenda not started yet" });
      return;
    }
    if (!agendashMiddleware) {
      agendashMiddleware = Agendash(agenda);
    }
    return agendashMiddleware(req, res, next);
  }
);

app.use(scoreRoutes);

// Populated by startAgenda() below — undefined until then. Constructing Agenda at module scope
// would connect to MongoDB as an import side-effect (Agenda's constructor connects synchronously
// when given a `db` config, independent of `.start()`), opening a second MongoClient connection
// alongside mongoose's own lazy/cached one from connectDB(). That broke smoke-health.ts and
// smoke-routes.ts, which import `app` from this module without ever starting/stopping Agenda.
// Task 11 (Agendash mounting) should read this export too; it's only populated once
// startAgenda() has resolved.
export let agenda: Agenda | undefined;

export async function startAgenda() {
  await connectDB();
  agenda = new Agenda({ db: { address: process.env.MONGODB_URI! } });
  defineCheckAndScoreJob(agenda);
  await agenda.start();
  const sweepIntervalMinutes = Number(process.env.SWEEP_INTERVAL_MINUTES) || 15;
  await agenda.every(`${sweepIntervalMinutes} minutes`, JOB_NAME);
}

if (require.main === module) {
  const port = Number(process.env.PORT ?? 3001);
  app.listen(port, () => console.log(`dashboard-sportz-automation listening on :${port}`));
  startAgenda().catch((err) => {
    console.error("Failed to start Agenda:", err);
    process.exit(1);
  });
}
