import mongoose, { Schema, Document, Model, Types } from "mongoose";

export interface IFantasy11PlayerPoint {
  playerName: string;
  points: number;
}

export interface IFantasy11Points extends Document {
  userId: Types.ObjectId;
  matchId: Types.ObjectId;
  leagueCode: string;
  groupId?: Types.ObjectId | null;
  groupNames: string[];
  rawPoints: number;
  rankPoints: number;
  playerPoints: IFantasy11PlayerPoint[];
}

const Fantasy11PlayerPointSchema = new Schema<IFantasy11PlayerPoint>(
  {
    playerName: { type: String, default: "" },
    points: { type: Number, default: 0 },
  },
  { _id: false }
);

const Fantasy11PointsSchema = new Schema<IFantasy11Points>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    matchId: { type: Schema.Types.ObjectId, ref: "Match", required: true },
    leagueCode: { type: String, required: true, uppercase: true, trim: true },
    groupId: { type: Schema.Types.ObjectId, ref: "Group", default: null, index: true },
    groupNames: { type: [String], default: [], index: true },
    rawPoints: { type: Number, required: true, default: 0 },
    rankPoints: { type: Number, required: true, default: 0 },
    playerPoints: { type: [Fantasy11PlayerPointSchema], default: [] },
  },
  { timestamps: true }
);

// Per-group unique constraint: one points record per user per match per league per group.
Fantasy11PointsSchema.index({ userId: 1, matchId: 1, leagueCode: 1, groupId: 1 }, { unique: true });
Fantasy11PointsSchema.index({ matchId: 1, leagueCode: 1 });
Fantasy11PointsSchema.index({ leagueCode: 1, groupNames: 1, matchId: 1 });

const existingFantasy11Points = mongoose.models.Fantasy11Points as Model<IFantasy11Points> | undefined;

if (existingFantasy11Points && !existingFantasy11Points.schema.path("groupNames")) {
  existingFantasy11Points.schema.add({
    groupNames: { type: [String], default: [], index: true },
  });
}

if (existingFantasy11Points && !existingFantasy11Points.schema.path("groupId")) {
  existingFantasy11Points.schema.add({
    groupId: { type: Schema.Types.ObjectId, ref: "Group", default: null, index: true },
  });
}

const Fantasy11Points: Model<IFantasy11Points> =
  existingFantasy11Points ||
  mongoose.model<IFantasy11Points>("Fantasy11Points", Fantasy11PointsSchema);

export default Fantasy11Points;
