import mongoose, { Schema, Document, Model, Types } from "mongoose";

// A player-created, shareable mini-league for one series. Distinct from the admin-curated
// Group model: internally it drives one hidden Group (internalGroupId) purely to reuse the
// existing team-drafting/scoring/leaderboard pipeline, which is keyed off groupId everywhere.
// That internal group is never surfaced to admins (see Group.isContestInternal).
export interface IContest extends Document {
  name: string;
  joinCode: string;
  seriesId: Types.ObjectId;
  leagueCode: string;
  linkedGroupId?: Types.ObjectId | null;
  internalGroupId: Types.ObjectId;
  internalGroupName: string;
  createdByEmail: string;
  // Set only for "advanced"-format cricket contests, which are scoped to a single match rather
  // than a whole series (unlike classic/fantasy11/football, where one contest spans the series
  // and the user drafts a team per match inside it). seriesId is still populated even when this
  // is set — resolved from the match's own series — since the scoring plumbing (Series.groupIds)
  // is per-series regardless.
  matchId?: Types.ObjectId | null;
}

const ContestSchema = new Schema<IContest>(
  {
    name: { type: String, required: true, trim: true },
    joinCode: { type: String, required: true, unique: true, uppercase: true },
    seriesId: { type: Schema.Types.ObjectId, ref: "Series", required: true, index: true },
    leagueCode: { type: String, required: true, trim: true, uppercase: true, index: true },
    linkedGroupId: { type: Schema.Types.ObjectId, ref: "Group", default: null },
    internalGroupId: { type: Schema.Types.ObjectId, ref: "Group", required: true },
    internalGroupName: { type: String, required: true, index: true },
    createdByEmail: { type: String, required: true, lowercase: true, trim: true },
    matchId: { type: Schema.Types.ObjectId, ref: "Match", default: null },
  },
  { timestamps: true }
);

const existingContestModel = mongoose.models.Contest as Model<IContest> | undefined;

// In Next.js dev hot-reload, an older cached model can miss newly added schema fields.
if (existingContestModel && !existingContestModel.schema.path("matchId")) {
  existingContestModel.schema.add({
    matchId: { type: Schema.Types.ObjectId, ref: "Match", default: null },
  });
}

const Contest: Model<IContest> =
  existingContestModel || mongoose.model<IContest>("Contest", ContestSchema);

export default Contest;
