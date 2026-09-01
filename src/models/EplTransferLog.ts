import mongoose, { Schema, Document, Model } from "mongoose";

// Mirrors dashboard-sportz's models/EplTransferLog.ts -- same MongoDB collection, same shape (see
// SeriesSquad.ts for why this repo duplicates models rather than sharing a package).
//
// A durable record of every EPL transfer this app has ever recognized, kept separate from
// SeriesSquad.players[].transferredOut/transferredTo -- those flags live on the squad document
// itself, which a re-pull (Pull Squad / Live API) replaces wholesale, silently wiping every flag
// back to false. This log survives that: it's the source of truth for "what transferred this
// window" regardless of whether the squad has since been refreshed out from under it.
export interface IEplTransferLog extends Document {
  seriesId: string;
  leagueCode: string;
  playerName: string;
  fromClub: string;
  toClub: string;
  transferDate?: Date | null;
  // Always "auto" today -- checkEplTransfers writes every row unconditionally, whether or not it
  // could confidently identify the player in the squad at check time (see checkEplTransfers.ts).
  // Kept as a field (rather than dropped) so a future write path has somewhere to record its own
  // provenance without a schema change.
  source: "auto";
}

const EplTransferLogSchema = new Schema<IEplTransferLog>(
  {
    seriesId: { type: String, required: true, index: true },
    leagueCode: { type: String, required: true, uppercase: true, index: true },
    playerName: { type: String, required: true, trim: true },
    fromClub: { type: String, required: true, trim: true },
    toClub: { type: String, required: true, trim: true },
    transferDate: { type: Date, default: null },
    source: { type: String, enum: ["auto"], required: true },
  },
  { timestamps: true }
);

EplTransferLogSchema.index({ leagueCode: 1, seriesId: 1, playerName: 1, fromClub: 1, toClub: 1 });

const EplTransferLog: Model<IEplTransferLog> =
  mongoose.models.EplTransferLog || mongoose.model<IEplTransferLog>("EplTransferLog", EplTransferLogSchema);

export default EplTransferLog;
