import "dotenv/config";
import express from "express";
import Agenda from "agenda";
import { scoreRoutes } from "./routes/scoreRoutes";
import { defineCheckAndScoreJob, JOB_NAME } from "./jobs/checkAndScoreMatches";
import { connectDB } from "./db";

export const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

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
  await agenda.every("10 minutes", JOB_NAME);
}

if (require.main === module) {
  const port = Number(process.env.PORT ?? 3001);
  app.listen(port, () => console.log(`dashboard-sportz-automation listening on :${port}`));
  startAgenda().catch((err) => {
    console.error("Failed to start Agenda:", err);
    process.exit(1);
  });
}
