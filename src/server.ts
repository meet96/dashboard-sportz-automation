import "dotenv/config";
import express from "express";
import { scoreRoutes } from "./routes/scoreRoutes";

export const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use(scoreRoutes);

if (require.main === module) {
  const port = Number(process.env.PORT ?? 3001);
  app.listen(port, () => {
    console.log(`dashboard-sportz-automation listening on :${port}`);
  });
}
