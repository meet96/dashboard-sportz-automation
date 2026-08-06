import mongoose, { Schema, Document, Model, Types } from "mongoose";

export interface IPlayerPoint {
  playerName: string;
  points: number;
  slotIndex?: number;
  teamCode?: string;
}

export interface IClassicPoints extends Document {
  teamId: Types.ObjectId;
  matchId: Types.ObjectId;
  points: number;          // total = sum of playerPoints.points
  playerPoints: IPlayerPoint[];
}

const PlayerPointSchema = new Schema<IPlayerPoint>(
  {
    playerName: { type: String, default: "" },
    points: { type: Number, default: 0 },
    // Additive metadata for deterministic replacement mapping.
    slotIndex: { type: Number, required: false },
    teamCode: { type: String, required: false, uppercase: true, trim: true },
  },
  { _id: false }
);

const ClassicPointsSchema = new Schema<IClassicPoints>(
  {
    teamId: { type: Schema.Types.ObjectId, ref: "ClassicTeam", required: true },
    matchId: { type: Schema.Types.ObjectId, ref: "Match", required: true },
    points: { type: Number, required: true, default: 0 },
    playerPoints: { type: [PlayerPointSchema], default: [] },
  },
  { timestamps: true }
);

ClassicPointsSchema.index({ teamId: 1, matchId: 1 }, { unique: true });
ClassicPointsSchema.index({ matchId: 1 });

const ClassicPoints: Model<IClassicPoints> =
  mongoose.models.ClassicPoints ||
  mongoose.model<IClassicPoints>("ClassicPoints", ClassicPointsSchema);

export default ClassicPoints;
