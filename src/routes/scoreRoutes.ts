import { Router } from "express";
import { connectDB } from "../db";
import { requireApiKey } from "../middleware/apiKeyAuth";
import { scoreClassicMatch } from "../services/scoreClassic";
import { scoreFantasy11Match } from "../services/scoreFantasy11";
import { scoreFootballMatch } from "../services/scoreFootball";
import { scoreFootballClassicMatchService } from "../services/scoreFootballClassic";
import { applyFootballMomBonus } from "../lib/scoreFootballClassicMatch";

export const scoreRoutes = Router();
scoreRoutes.use(requireApiKey);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

scoreRoutes.post("/matches/:id/score/classic", async (req, res) => {
  try {
    await connectDB();
    const result = await scoreClassicMatch(req.params.id, { cricbuzzMatchId: req.body?.cricbuzzMatchId, allowIncomplete: req.body?.allowIncomplete === true });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: errorMessage(err) });
  }
});

scoreRoutes.post("/matches/:id/score/fantasy11", async (req, res) => {
  try {
    await connectDB();
    const result = await scoreFantasy11Match(req.params.id, { cricbuzzMatchId: req.body?.cricbuzzMatchId, allowIncomplete: req.body?.allowIncomplete === true });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: errorMessage(err) });
  }
});

scoreRoutes.post("/matches/:id/score/football", async (req, res) => {
  try {
    await connectDB();
    const result = await scoreFootballMatch(req.params.id, {
      espnEventId: req.body?.espnEventId,
      espnUrl: req.body?.espnUrl,
      footballFixtureId: req.body?.footballFixtureId,
      allowIncomplete: req.body?.allowIncomplete === true,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: errorMessage(err) });
  }
});

scoreRoutes.post("/matches/:id/score/football-classic", async (req, res) => {
  try {
    await connectDB();
    const result = await scoreFootballClassicMatchService(req.params.id, { cricbuzzMatchId: req.body?.cricbuzzMatchId });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: errorMessage(err) });
  }
});

scoreRoutes.post("/matches/:id/mom/football-classic", async (req, res) => {
  try {
    await connectDB();
    const { leagueCode, playerName } = req.body ?? {};
    if (!leagueCode || !playerName) {
      return res.status(400).json({ error: "leagueCode and playerName are required" });
    }
    const result = await applyFootballMomBonus(req.params.id, String(leagueCode).toUpperCase(), String(playerName));
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: errorMessage(err) });
  }
});
