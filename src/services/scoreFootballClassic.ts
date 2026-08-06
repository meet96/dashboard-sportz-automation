import { scoreFootballClassicMatch } from "../lib/scoreFootballClassicMatch";

export async function scoreFootballClassicMatchService(matchId: string, opts: { cricbuzzMatchId?: string } = {}) {
  return scoreFootballClassicMatch(matchId, opts.cricbuzzMatchId);
}
