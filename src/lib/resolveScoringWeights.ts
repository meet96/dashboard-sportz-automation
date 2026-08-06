import type { ScoringWeights } from "./cricbuzz";

export interface ScoringConfigLike {
  teamSize?: number;
  bonusMultiplier?: number;
  momMultiplier?: number;
  pointsPerRun: number;
  pointsPerFour?: number;
  pointsPerSix?: number;
  fiftyBonus?: number;
  centuryBonus?: number;
  catchPoints: number;
  runOutPoints?: number;
  wicketPoints: number;
  threeWicketBonus?: number;
  fiveWicketBonus?: number;
  stumpingPoints: number;
}

// Shared by scoreClassic.ts and scoreFantasy11.ts — both map a league's ScoringConfig doc onto
// ScoringWeights the same way, falling back to caller-supplied defaults per field. The only
// difference between the two call sites is which defaults they pass in (classic uses
// DEFAULT_WEIGHTS as-is; fantasy11 overrides teamSize to 11) — that stays at the call site.
export function resolveScoringWeights(cfg: ScoringConfigLike | null, defaults: ScoringWeights): ScoringWeights {
  if (!cfg) return defaults;
  return {
    teamSize: cfg.teamSize ?? defaults.teamSize,
    bonusMultiplier: cfg.bonusMultiplier ?? defaults.bonusMultiplier,
    momMultiplier: cfg.momMultiplier ?? defaults.momMultiplier,
    pointsPerRun: cfg.pointsPerRun,
    pointsPerFour: cfg.pointsPerFour ?? defaults.pointsPerFour,
    pointsPerSix: cfg.pointsPerSix ?? defaults.pointsPerSix,
    fiftyBonus: cfg.fiftyBonus ?? defaults.fiftyBonus,
    centuryBonus: cfg.centuryBonus ?? defaults.centuryBonus,
    catchPoints: cfg.catchPoints,
    runOutPoints: cfg.runOutPoints ?? defaults.runOutPoints,
    wicketPoints: cfg.wicketPoints,
    threeWicketBonus: cfg.threeWicketBonus ?? defaults.threeWicketBonus,
    fiveWicketBonus: cfg.fiveWicketBonus ?? defaults.fiveWicketBonus,
    stumpingPoints: cfg.stumpingPoints,
  };
}
