import mongoose, { Schema, Document, Model } from "mongoose";

export interface IGroup extends Document {
  name: string;
  leagueCode?: string;
  leagueCodes: string[];
  isActive: boolean;
  isContestInternal?: boolean;
  createdByEmail?: string | null;
}

const GroupSchema = new Schema<IGroup>(
  {
    name: { type: String, required: true, trim: true },
    leagueCode: { type: String, trim: true, uppercase: true, index: true },
    leagueCodes: { type: [String], default: [], index: true },
    isActive: { type: Boolean, default: true },
    // Marks the hidden scoring-plumbing group auto-created behind a player-made Contest —
    // excluded from admin-facing group listings/pickers (see app/api/groups/route.ts).
    isContestInternal: { type: Boolean, default: false },
    // Set when a player created this group themselves (via /api/player-groups) rather than an
    // admin — lets the admin panel tell the two apart. Null for admin-created groups.
    createdByEmail: { type: String, default: null, lowercase: true, trim: true },
  },
  { timestamps: true }
);

GroupSchema.index({ leagueCode: 1, name: 1 }, { unique: true });

const existingGroupModel = mongoose.models.Group as Model<IGroup> | undefined;

if (existingGroupModel && !existingGroupModel.schema.path("isActive")) {
  existingGroupModel.schema.add({ isActive: { type: Boolean, default: true } });
}

if (existingGroupModel && !existingGroupModel.schema.path("leagueCodes")) {
  existingGroupModel.schema.add({ leagueCodes: { type: [String], default: [], index: true } });
}

if (existingGroupModel && !existingGroupModel.schema.path("isContestInternal")) {
  existingGroupModel.schema.add({ isContestInternal: { type: Boolean, default: false } });
}

if (existingGroupModel && !existingGroupModel.schema.path("createdByEmail")) {
  existingGroupModel.schema.add({ createdByEmail: { type: String, default: null, lowercase: true, trim: true } });
}

const Group: Model<IGroup> =
  existingGroupModel || mongoose.model<IGroup>("Group", GroupSchema);

export default Group;
