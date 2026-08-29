import mongoose, { Schema, Document, Model } from "mongoose";

// Mirrors dashboard-sportz's models/SeriesSquad.ts -- same MongoDB collection, same shape. Kept
// as a separate Mongoose model file per this repo's existing convention (see models/Match.ts,
// models/ClassicTeam.ts) rather than a shared package, since the two repos already duplicate
// every other model they both touch.
export interface ISeriesSquad extends Document {
  seriesId: string;
  seriesName: string;
  leagueCode: string;
  year: number;
  homeTeamId?: string;
  homeTeamName?: string;
  awayTeamId?: string;
  awayTeamName?: string;
  players: Array<{
    playerName: string;
    teamId: string;
    teamName: string;
    position?: string;
    role?: string;
    transferredOut?: boolean;
    transferredTo?: string;
    transferredAt?: Date;
  }>;
  pulledAt: Date;
}

const SeriesSquadSchema = new Schema<ISeriesSquad>(
  {
    seriesId: { type: String, required: true, index: true },
    seriesName: { type: String, required: true, trim: true },
    leagueCode: { type: String, required: true, uppercase: true, index: true },
    year: { type: Number, required: true },
    homeTeamId: { type: String, default: "" },
    homeTeamName: { type: String, default: "" },
    awayTeamId: { type: String, default: "" },
    awayTeamName: { type: String, default: "" },
    players: {
      type: [
        {
          playerName: { type: String, required: true, trim: true },
          teamId: { type: String, required: true },
          teamName: { type: String, required: true, trim: true },
          position: { type: String, default: "" },
          role: { type: String, default: "" },
          transferredOut: { type: Boolean, default: false },
          transferredTo: { type: String, default: "" },
          transferredAt: { type: Date, default: null },
          _id: false,
        },
      ],
      default: [],
    },
    pulledAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true }
);

SeriesSquadSchema.index({ leagueCode: 1, seriesId: 1 });

const SeriesSquad: Model<ISeriesSquad> =
  mongoose.models.SeriesSquad || mongoose.model<ISeriesSquad>("SeriesSquad", SeriesSquadSchema);

export default SeriesSquad;
