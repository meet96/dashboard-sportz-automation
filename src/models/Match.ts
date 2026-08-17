import mongoose, { Schema, Document, Model } from "mongoose";

export interface IScorecardPlayer {
  name: string;
  runs: number; fours: number; sixes: number;
  wickets: number; catches: number; runOuts: number; stumpings: number;
  position?: string;
  goals?: number;
  assists?: number;
  shotsOnTarget?: number;
  saves?: number;
  yellowCards?: number;
  redCards?: number;
  minutesPlayed?: number;
}

export interface IScorecardPlayerPoint {
  playerName: string; points: number;
  position?: string;
  runs: number; fours: number; sixes: number;
  wickets: number; catches: number; runOuts: number; stumpings: number;
  goals?: number;
  assists?: number;
  yellowCards?: number;
  redCards?: number;
  cleanSheetBonus?: number;
}

export interface IScorecardTeamResult {
  teamId: string; teamName: string; userName?: string; leagueCode: string;
  points: number;
  playerPoints: IScorecardPlayerPoint[];
  unmatched: string[];
}

export interface IScorecard {
  scoredAt: Date;
  players: IScorecardPlayer[];
  teamResults: IScorecardTeamResult[];
}

export interface IMatch extends Document {
  matchName: string;
  series?: string[];
  date: Date;
  isCompleted: boolean;
  noResult: boolean;
  year: number;
  leagueCodes: string[];
  cricbuzzMatchId?: string | null;
  scorecard?: IScorecard | null;
  // Set while a Test match is at Stumps: the sweep skips this match entirely (not even a status
  // check) until this time, instead of polling every 15 minutes through a predictable ~14-17h
  // overnight gap where no new data can possibly appear. Null/unset means "poll normally".
  nextEligibleCheckAt?: Date | null;
}

const ScorecardPlayerSchema = new Schema<IScorecardPlayer>({
  name: { type: String, required: true },
  runs: { type: Number, default: 0 }, fours: { type: Number, default: 0 }, sixes: { type: Number, default: 0 },
  wickets: { type: Number, default: 0 }, catches: { type: Number, default: 0 },
  runOuts: { type: Number, default: 0 }, stumpings: { type: Number, default: 0 },
  position: { type: String, default: "" },
  goals: { type: Number, default: 0 },
  assists: { type: Number, default: 0 },
  shotsOnTarget: { type: Number, default: 0 },
  saves: { type: Number, default: 0 },
  yellowCards: { type: Number, default: 0 },
  redCards: { type: Number, default: 0 },
  minutesPlayed: { type: Number, default: 0 },
}, { _id: false });

const ScorecardPlayerPointSchema = new Schema<IScorecardPlayerPoint>({
  playerName: { type: String, required: true }, points: { type: Number, default: 0 },
  position: { type: String, default: "" },
  runs: { type: Number, default: 0 }, fours: { type: Number, default: 0 }, sixes: { type: Number, default: 0 },
  wickets: { type: Number, default: 0 }, catches: { type: Number, default: 0 },
  runOuts: { type: Number, default: 0 }, stumpings: { type: Number, default: 0 },
  goals: { type: Number, default: 0 },
  assists: { type: Number, default: 0 },
  yellowCards: { type: Number, default: 0 },
  redCards: { type: Number, default: 0 },
  cleanSheetBonus: { type: Number, default: 0 },
}, { _id: false });

const ScorecardTeamResultSchema = new Schema<IScorecardTeamResult>({
  teamId: { type: String, required: true }, teamName: { type: String, required: true },
  userName: { type: String, default: "" },
  leagueCode: { type: String, required: true }, points: { type: Number, default: 0 },
  playerPoints: { type: [ScorecardPlayerPointSchema], default: [] },
  unmatched: { type: [String], default: [] },
}, { _id: false });

const ScorecardSchema = new Schema<IScorecard>({
  scoredAt: { type: Date, required: true },
  players: { type: [ScorecardPlayerSchema], default: [] },
  teamResults: { type: [ScorecardTeamResultSchema], default: [] },
}, { _id: false });

const MatchSchema = new Schema<IMatch>(
  {
    matchName: { type: String, required: true, trim: true },
    series: { type: [String], default: [] },
    date: { type: Date, required: true },
    isCompleted: { type: Boolean, default: false },
    noResult: { type: Boolean, default: false },
    year: { type: Number, required: true, default: () => new Date().getFullYear() },
    leagueCodes: { type: [String], default: [], index: true },
    cricbuzzMatchId: { type: String, default: null },
    scorecard: { type: ScorecardSchema, default: null },
    nextEligibleCheckAt: { type: Date, default: null },
  },
  { timestamps: true }
);

MatchSchema.index({ year: 1, date: -1 });
MatchSchema.index({ isCompleted: 1, year: 1 });
MatchSchema.index({ leagueCodes: 1, year: 1, series: 1, date: 1 });

const existingMatchModel = mongoose.models.Match as Model<IMatch> | undefined;

// In Next.js dev hot-reload, an older cached model can miss newly added schema fields.
// Patch the cached schema so fields like `series` are persisted without requiring a server restart.
if (existingMatchModel && !existingMatchModel.schema.path("series")) {
  existingMatchModel.schema.add({
    series: { type: [String], default: [] },
  });
}

if (existingMatchModel) {
  const scorecardSchema = (existingMatchModel.schema.path("scorecard") as { schema?: Schema } | undefined)?.schema;
  const playersSchema = (scorecardSchema?.path("players") as { schema?: Schema } | undefined)?.schema;
  const playerPointsSchema = (scorecardSchema?.path("teamResults") as { schema?: Schema } | undefined)?.schema
    ?.path("playerPoints") as { schema?: Schema } | undefined;

  if (playersSchema && !playersSchema.path("goals")) {
    playersSchema.add({
      position: { type: String, default: "" },
      goals: { type: Number, default: 0 },
      assists: { type: Number, default: 0 },
      yellowCards: { type: Number, default: 0 },
      redCards: { type: Number, default: 0 },
    });
  }

  if (playerPointsSchema?.schema && !playerPointsSchema.schema.path("goals")) {
    playerPointsSchema.schema.add({
      position: { type: String, default: "" },
      goals: { type: Number, default: 0 },
      assists: { type: Number, default: 0 },
      yellowCards: { type: Number, default: 0 },
      redCards: { type: Number, default: 0 },
      cleanSheetBonus: { type: Number, default: 0 },
    });
  }

  if (playerPointsSchema?.schema && !playerPointsSchema.schema.path("position")) {
    playerPointsSchema.schema.add({
      position: { type: String, default: "" },
    });
  }
}

const Match: Model<IMatch> =
  existingMatchModel || mongoose.model<IMatch>("Match", MatchSchema);

export default Match;
