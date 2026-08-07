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

export const agenda = new Agenda({ db: { address: process.env.MONGODB_URI! } });
defineCheckAndScoreJob(agenda);

export async function startAgenda() {
  await connectDB();
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
