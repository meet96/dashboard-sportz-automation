import mongoose, { Schema, Document, Model } from "mongoose";

export interface IScoringConfig extends Document {
  leagueCode: string;
  leagueStageMatches: number; // number of league-stage matches before playoffs unlock (default 70)
  teamSize: number;           // max players per team (default 8, max 15)
  bonusMultiplier: number;    // multiplies manual classic bonus points (default 1)
  momMultiplier: number;      // multiplies manual classic MOM points (default 1)
  pointsPerRun: number;       // per run scored (default 1)
  pointsPerFour: number;      // additional points per boundary four (default 2)
  pointsPerSix: number;       // additional points per six (default 5)
  fiftyBonus: number;         // bonus for scoring 50+ runs (default 25)
  centuryBonus: number;       // bonus for scoring 100+ runs (default 50)
  catchPoints: number;        // per catch (default 10)
  runOutPoints: number;       // per run out effected (default 10)
  wicketPoints: number;       // per wicket taken (default 25)
  threeWicketBonus: number;   // bonus for 3+ wickets in an innings (default 25)
  fiveWicketBonus: number;    // bonus for 5+ wickets in an innings (default 50)
  stumpingPoints: number;     // per stumping (default 10)
  goalPoints?: number;        // football: points per goal
  assistPoints?: number;      // football: points per assist
  strikerGoalPoints?: number;   // football classic: striker goal points
  midfielderGoalPoints?: number;// football classic: midfielder goal points
  defenderGoalPoints?: number;  // football classic: defender goal points
  goalkeeperGoalPoints?: number;// football classic: goalkeeper goal points
  strikerAssistPoints?: number;   // football classic: striker assist points
  midfielderAssistPoints?: number;// football classic: midfielder assist points
  defenderAssistPoints?: number;  // football classic: defender assist points
  goalkeeperAssistPoints?: number;// football classic: goalkeeper assist points
  shotOnTargetPoints?: number;// football: points per shot on target
  savePoints?: number;        // football: points per save
  yellowCardPoints?: number;  // football: points per yellow card (typically negative)
  redCardPoints?: number;     // football: points per red card (typically negative)
  goalkeeperCleanSheetPoints?: number; // football: goalkeeper clean sheet bonus
  defenderCleanSheetPoints?: number;   // football: defender clean sheet bonus
  appearancePoints?: number;  // football: played minutes > 0
  fullMatchBonus?: number;    // football: 90+ mins bonus
}

const ScoringConfigSchema = new Schema<IScoringConfig>(
  {
    leagueCode: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
    },
    leagueStageMatches: { type: Number, default: 70, min: 1 },
    teamSize:          { type: Number, default: 8,  min: 8, max: 15 },
    bonusMultiplier:   { type: Number, default: 1,  min: 0 },
    momMultiplier:     { type: Number, default: 1,  min: 0 },
    pointsPerRun:      { type: Number, default: 1,  min: 0 },
    pointsPerFour:     { type: Number, default: 2,  min: 0 },
    pointsPerSix:      { type: Number, default: 5,  min: 0 },
    fiftyBonus:        { type: Number, default: 25, min: 0 },
    centuryBonus:      { type: Number, default: 50, min: 0 },
    catchPoints:       { type: Number, default: 10, min: 0 },
    runOutPoints:      { type: Number, default: 10, min: 0 },
    wicketPoints:      { type: Number, default: 25, min: 0 },
    threeWicketBonus:  { type: Number, default: 25, min: 0 },
    fiveWicketBonus:   { type: Number, default: 50, min: 0 },
    stumpingPoints:    { type: Number, default: 10, min: 0 },
    goalPoints:        { type: Number, default: 50 },
    assistPoints:      { type: Number, default: 25 },
    strikerGoalPoints:    { type: Number, default: 10 },
    midfielderGoalPoints: { type: Number, default: 20 },
    defenderGoalPoints:   { type: Number, default: 30 },
    goalkeeperGoalPoints: { type: Number, default: 50 },
    strikerAssistPoints:    { type: Number, default: 10 },
    midfielderAssistPoints: { type: Number, default: 10 },
    defenderAssistPoints:   { type: Number, default: 20 },
    goalkeeperAssistPoints: { type: Number, default: 30 },
    shotOnTargetPoints:{ type: Number, default: 5 },
    savePoints:        { type: Number, default: 2 },
    yellowCardPoints:  { type: Number, default: -10 },
    redCardPoints:     { type: Number, default: -25 },
    goalkeeperCleanSheetPoints: { type: Number, default: 50 },
    defenderCleanSheetPoints:   { type: Number, default: 25 },
    appearancePoints:  { type: Number, default: 2 },
    fullMatchBonus:    { type: Number, default: 4 },
  },
  { timestamps: true }
);

const ScoringConfig: Model<IScoringConfig> =
  mongoose.models.ScoringConfig ||
  mongoose.model<IScoringConfig>("ScoringConfig", ScoringConfigSchema);

export default ScoringConfig;
