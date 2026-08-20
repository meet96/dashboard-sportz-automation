import mongoose, { Schema, Document, Model, Types } from "mongoose";

export interface IClassicBonus extends Document {
  userId: Types.ObjectId;
  matchId: Types.ObjectId;
  leagueCode: string;
  bonusPoints: number;
  groupId?: Types.ObjectId | null;
  seriesId?: Types.ObjectId | null;
}

const ClassicBonusSchema = new Schema<IClassicBonus>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    matchId: { type: Schema.Types.ObjectId, ref: "Match", required: true },
    leagueCode: { type: String, required: true, uppercase: true, trim: true },
    bonusPoints: { type: Number, default: 0 },
    // Present when this leagueCode hosts more than one classic-format group (see
    // Series.groupFormats) — kept nullable/non-unique for now since a single leagueCode+match
    // still maps to exactly one user's bonus today; widen the unique index below if/when a
    // second classic-format group is added under the same leagueCode.
    groupId: { type: Schema.Types.ObjectId, ref: "Group", default: null },
    seriesId: { type: Schema.Types.ObjectId, ref: "Series", default: null },
  },
  { timestamps: true }
);

ClassicBonusSchema.index({ userId: 1, matchId: 1, leagueCode: 1 }, { unique: true });
ClassicBonusSchema.index({ matchId: 1 });

const existingClassicBonusModel = mongoose.models.ClassicBonus as Model<IClassicBonus> | undefined;

if (existingClassicBonusModel && !existingClassicBonusModel.schema.path("groupId")) {
  existingClassicBonusModel.schema.add({ groupId: { type: Schema.Types.ObjectId, ref: "Group", default: null } });
}
if (existingClassicBonusModel && !existingClassicBonusModel.schema.path("seriesId")) {
  existingClassicBonusModel.schema.add({ seriesId: { type: Schema.Types.ObjectId, ref: "Series", default: null } });
}

const ClassicBonus: Model<IClassicBonus> =
  existingClassicBonusModel ||
  mongoose.model<IClassicBonus>("ClassicBonus", ClassicBonusSchema);

export default ClassicBonus;
