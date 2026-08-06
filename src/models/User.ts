import mongoose, { Schema, Document, Model } from "mongoose";

export interface IUser extends Document {
  name: string;
  totalPoints: number;
  matchesPlayed: number;
  isQualified: boolean;
  leagueCode?: string | null;
  leagueCodes?: string[];
  groupName?: string | null;
  groupNames?: string[];
}

const UserSchema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true },
    totalPoints: { type: Number, default: 0 },
    matchesPlayed: { type: Number, default: 0 },
    isQualified: { type: Boolean, default: false },
    leagueCode: { type: String, default: null, index: true },
    leagueCodes: { type: [String], default: [], index: true },
    groupName: { type: String, default: null, trim: true, index: true },
    groupNames: { type: [String], default: [], index: true },
  },
  { timestamps: true }
);

const existingUserModel = mongoose.models.User as Model<IUser> | undefined;

if (existingUserModel && !existingUserModel.schema.path("groupName")) {
  existingUserModel.schema.add({
    groupName: { type: String, default: null, trim: true, index: true },
  });
}

if (existingUserModel && !existingUserModel.schema.path("groupNames")) {
  existingUserModel.schema.add({
    groupNames: { type: [String], default: [], index: true },
  });
}

if (existingUserModel && !existingUserModel.schema.path("leagueCodes")) {
  existingUserModel.schema.add({
    leagueCodes: { type: [String], default: [], index: true },
  });
}

const User: Model<IUser> =
  existingUserModel || mongoose.model<IUser>("User", UserSchema);

export default User;
