import mongoose, { Schema, Document, Model, Types } from "mongoose";

export interface IClassicMOM extends Document {
  userId: Types.ObjectId;
  matchId: Types.ObjectId;
  leagueCode: string;
  momPoints: number;
  groupId?: Types.ObjectId | null;
  seriesId?: Types.ObjectId | null;
}

const ClassicMOMSchema = new Schema<IClassicMOM>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    matchId: { type: Schema.Types.ObjectId, ref: "Match", required: true },
    leagueCode: { type: String, required: true, uppercase: true, trim: true },
    momPoints: { type: Number, default: 0 },
    // See ClassicBonus.groupId/seriesId — same rationale.
    groupId: { type: Schema.Types.ObjectId, ref: "Group", default: null },
    seriesId: { type: Schema.Types.ObjectId, ref: "Series", default: null },
  },
  { timestamps: true }
);

ClassicMOMSchema.index({ userId: 1, matchId: 1, leagueCode: 1 }, { unique: true });
ClassicMOMSchema.index({ matchId: 1 });

const existingClassicMOMModel = mongoose.models.ClassicMOM as Model<IClassicMOM> | undefined;

if (existingClassicMOMModel && !existingClassicMOMModel.schema.path("groupId")) {
  existingClassicMOMModel.schema.add({ groupId: { type: Schema.Types.ObjectId, ref: "Group", default: null } });
}
if (existingClassicMOMModel && !existingClassicMOMModel.schema.path("seriesId")) {
  existingClassicMOMModel.schema.add({ seriesId: { type: Schema.Types.ObjectId, ref: "Series", default: null } });
}

const ClassicMOM: Model<IClassicMOM> =
  existingClassicMOMModel ||
  mongoose.model<IClassicMOM>("ClassicMOM", ClassicMOMSchema);

export default ClassicMOM;
