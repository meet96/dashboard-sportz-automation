import mongoose, { Schema, Document, Model, Types } from "mongoose";

export interface IFantasy11Team extends Document {
  userId: Types.ObjectId;
  matchId: Types.ObjectId;
  leagueCode: string;
  groupId?: Types.ObjectId | null;
  groupNames: string[];
  players: string[];
  captain: string;
  viceCaptain: string;
  points?: number;
}

const Fantasy11TeamSchema = new Schema<IFantasy11Team>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    matchId: { type: Schema.Types.ObjectId, ref: "Match", required: true },
    leagueCode: { type: String, required: true, uppercase: true, trim: true },
    groupId: { type: Schema.Types.ObjectId, ref: "Group", default: null, index: true },
    groupNames: { type: [String], default: [], index: true },
    players: [{ type: String, trim: true }],
    captain: { type: String, default: "", trim: true },
    viceCaptain: { type: String, default: "", trim: true },
    points: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Per-group unique constraint: one team per user per match per league per group.
// groupId: null covers legacy records (no group) and also "no group selected".
Fantasy11TeamSchema.index({ userId: 1, matchId: 1, leagueCode: 1, groupId: 1 }, { unique: true });
Fantasy11TeamSchema.index({ matchId: 1, leagueCode: 1 });
Fantasy11TeamSchema.index({ leagueCode: 1, groupNames: 1, matchId: 1 });

const existingFantasy11Team = mongoose.models.Fantasy11Team as Model<IFantasy11Team> | undefined;

if (existingFantasy11Team && !existingFantasy11Team.schema.path("groupNames")) {
  existingFantasy11Team.schema.add({
    groupNames: { type: [String], default: [], index: true },
  });
}

if (existingFantasy11Team && !existingFantasy11Team.schema.path("points")) {
  existingFantasy11Team.schema.add({
    points: { type: Number, default: 0 },
  });
}

if (existingFantasy11Team && !existingFantasy11Team.schema.path("groupId")) {
  existingFantasy11Team.schema.add({
    groupId: { type: Schema.Types.ObjectId, ref: "Group", default: null, index: true },
  });
}

const Fantasy11Team: Model<IFantasy11Team> =
  existingFantasy11Team ||
  mongoose.model<IFantasy11Team>("Fantasy11Team", Fantasy11TeamSchema);

export default Fantasy11Team;
