import mongoose, { Schema, Document, Model, Types } from "mongoose";

export interface IClassicTeam extends Document {
  userId: Types.ObjectId;
  leagueCode: string;
  teamSlot: 1 | 2;
  teamName: string;
  players: string[];
  playerTeamNames: string[];
  seriesId?: Types.ObjectId | null;
  groupId?: Types.ObjectId | null;
}

const ClassicTeamSchema = new Schema<IClassicTeam>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    leagueCode: { type: String, required: true, uppercase: true, trim: true },
    teamSlot: { type: Number, enum: [1, 2], required: true },
    teamName: { type: String, default: "", trim: true },
    players: [{ type: String, trim: true }],
    playerTeamNames: [{ type: String, trim: true, default: "" }],
    seriesId: { type: Schema.Types.ObjectId, ref: "Series", default: null, index: true },
    groupId: { type: Schema.Types.ObjectId, ref: "Group", default: null, index: true },
  },
  { timestamps: true }
);

// Per-group-per-series unique constraint (replaces old { userId, leagueCode, teamSlot }).
// Run migrate-classic-series-group.js first to drop the old index and backfill existing records.
ClassicTeamSchema.index(
  { userId: 1, leagueCode: 1, groupId: 1, seriesId: 1, teamSlot: 1 },
  { unique: true }
);
ClassicTeamSchema.index({ leagueCode: 1 });

const existingClassicTeamModel = mongoose.models.ClassicTeam as Model<IClassicTeam> | undefined;

// Patch cached model in hot-reload so new fields are recognised without a full restart.
if (existingClassicTeamModel) {
  if (!existingClassicTeamModel.schema.path("seriesId")) {
    existingClassicTeamModel.schema.add({
      seriesId: { type: Schema.Types.ObjectId, ref: "Series", default: null },
    });
  }
  if (!existingClassicTeamModel.schema.path("groupId")) {
    existingClassicTeamModel.schema.add({
      groupId: { type: Schema.Types.ObjectId, ref: "Group", default: null },
    });
  }
  if (!existingClassicTeamModel.schema.path("playerTeamNames")) {
    existingClassicTeamModel.schema.add({
      playerTeamNames: [{ type: String, trim: true, default: "" }],
    });
  }
}

const ClassicTeam: Model<IClassicTeam> =
  existingClassicTeamModel ||
  mongoose.model<IClassicTeam>("ClassicTeam", ClassicTeamSchema);

export default ClassicTeam;
