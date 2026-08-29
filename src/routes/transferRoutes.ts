import { Router } from "express";
import { connectDB } from "../db";
import { requireApiKey } from "../middleware/apiKeyAuth";
import { checkEplTransfers } from "../services/checkEplTransfers";

export const transferRoutes = Router();
transferRoutes.use(requireApiKey);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

transferRoutes.post("/transfers/epl/check", async (req, res) => {
  try {
    await connectDB();
    const { seriesId, leagueCode } = req.body ?? {};
    if (!seriesId || !leagueCode) {
      return res.status(400).json({ error: "seriesId and leagueCode are required" });
    }
    const result = await checkEplTransfers(String(seriesId), String(leagueCode).toUpperCase());
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: errorMessage(err) });
  }
});
