import mongoose, { Schema, Document, Model } from "mongoose";

export interface ILeagueCode extends Document {
  code: string;
  name: string;
  isActive: boolean;
  gameType: "classic" | "advanced" | "fantasy11" | "football";
  teamDeadline?: Date | null;
}

const LeagueCodeSchema = new Schema<ILeagueCode>(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      maxlength: 30,
      match: /^[A-Z0-9]+$/,
    },
    name: { type: String, required: true, trim: true },
    isActive: { type: Boolean, default: false },
    gameType: { type: String, enum: ["classic", "advanced", "fantasy11", "football"], default: "classic" },
    teamDeadline: { type: Date, default: null },
  },
  { timestamps: true }
);

const LeagueCode: Model<ILeagueCode> =
  mongoose.models.LeagueCode || mongoose.model<ILeagueCode>("LeagueCode", LeagueCodeSchema);

export default LeagueCode;
