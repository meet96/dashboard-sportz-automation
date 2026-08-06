import mongoose, { Schema, Document, Model, Types } from "mongoose";

export type SeriesFormat = "classic" | "advanced" | "fantasy11" | "football";

export interface IGroupFormat {
  groupId: Types.ObjectId;
  format: SeriesFormat;
}

export interface ISeries extends Document {
  name: string;
  leagueCode: string;
  year: number;
  isActive: boolean;
  status: "active" | "completed";
  groupIds: Types.ObjectId[];
  cricbuzzSeriesId?: string | null;
  teamDeadline?: Date | null;
  hasPlayoffs: boolean;
  leagueStageMatches?: number | null;
  groupFormats: IGroupFormat[];
}

const SeriesSchema = new Schema<ISeries>(
  {
    name: { type: String, required: true, trim: true },
    leagueCode: { type: String, required: true, trim: true, uppercase: true, index: true },
    year: { type: Number, required: true, index: true },
    isActive: { type: Boolean, default: true },
    status: { type: String, enum: ["active", "completed"], default: "active", index: true },
    groupIds: [{ type: Schema.Types.ObjectId, ref: "Group" }],
    cricbuzzSeriesId: { type: String, default: null, sparse: true },
    teamDeadline: { type: Date, default: null },
    // Explicit admin-controlled switch for a Q1/Eliminator/Q2/Final knockout stage — replaces
    // sniffing match names to decide whether to render the playoffs bracket.
    hasPlayoffs: { type: Boolean, default: false },
    // Number of league-stage matches in this series (chronologically first N, by date) before
    // playoffs start. Like ScoringConfig.leagueStageMatches but scoped per-series, since one
    // league code (e.g. FANTASY11) can host several series with very different match counts.
    // Null/unset falls back to match-name-pattern detection.
    leagueStageMatches: { type: Number, default: null, min: 1 },
    // Per-group format override — lets a single series host groups playing different game
    // formats (e.g. one group drafts fantasy11-style, another classic-style) under one
    // leagueCode/login instead of needing a dedicated leagueCode per format. A group with no
    // entry here falls back to this series' LeagueCode.gameType (see lib/seriesFormat.ts).
    groupFormats: {
      type: [
        {
          groupId: { type: Schema.Types.ObjectId, ref: "Group", required: true },
          format: { type: String, enum: ["classic", "advanced", "fantasy11", "football"], required: true },
          _id: false,
        },
      ],
      default: [],
    },
  },
  { timestamps: true }
);

SeriesSchema.index({ leagueCode: 1, year: 1, name: 1 }, { unique: true });

const existingSeriesModel = mongoose.models.Series as Model<ISeries> | undefined;

if (existingSeriesModel && !existingSeriesModel.schema.path("groupIds")) {
  existingSeriesModel.schema.add({
    groupIds: [{ type: Schema.Types.ObjectId, ref: "Group" }],
  });
}

if (existingSeriesModel && !existingSeriesModel.schema.path("status")) {
  existingSeriesModel.schema.add({
    status: { type: String, enum: ["active", "completed"], default: "active", index: true },
  });
}

if (existingSeriesModel && !existingSeriesModel.schema.path("teamDeadline")) {
  existingSeriesModel.schema.add({ teamDeadline: { type: Date, default: null } });
}

if (existingSeriesModel && !existingSeriesModel.schema.path("hasPlayoffs")) {
  existingSeriesModel.schema.add({ hasPlayoffs: { type: Boolean, default: false } });
}

if (existingSeriesModel && !existingSeriesModel.schema.path("leagueStageMatches")) {
  existingSeriesModel.schema.add({ leagueStageMatches: { type: Number, default: null, min: 1 } });
}

if (existingSeriesModel && !existingSeriesModel.schema.path("groupFormats")) {
  existingSeriesModel.schema.add({
    groupFormats: {
      type: [
        {
          groupId: { type: Schema.Types.ObjectId, ref: "Group", required: true },
          format: { type: String, enum: ["classic", "advanced", "fantasy11", "football"], required: true },
          _id: false,
        },
      ],
      default: [],
    },
  });
}

const Series: Model<ISeries> =
  existingSeriesModel || mongoose.model<ISeries>("Series", SeriesSchema);

export default Series;
