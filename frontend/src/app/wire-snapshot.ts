import type {
  BakedHistogram,
  EnvelopeBin,
  SignalSummary,
} from "../generated/protocol";
import { levelFromBins, type BakedSnapshot } from "./snapshot-payload";

export interface WireSnapshot {
  session_json: string;
  preferences_json?: string | null;
  signals: { summary: SignalSummary; levels: EnvelopeBin[][] }[];
  line2d?:
    | {
        x_signal_id: string;
        y_signal_ids: string[];
        levels: {
          level: number;
          anchor: number[];
          x: (number | null)[];
          ys: (number | null)[][];
        }[];
      }[]
    | null;
  histograms?: BakedHistogram[] | null;
}

/** Builds an in-memory snapshot from wire-shaped test data. */
export function snapshotFromWire(wire: WireSnapshot): BakedSnapshot {
  const column = (values: readonly (number | null)[]) =>
    Float64Array.from(values, (value) => value ?? Number.NaN);
  return {
    sessionJson: wire.session_json,
    preferencesJson: wire.preferences_json ?? null,
    signals: wire.signals.map((signal) => ({
      summary: signal.summary,
      levels: signal.levels.map(levelFromBins),
    })),
    line2d: (wire.line2d ?? []).map((line) => ({
      x_signal_id: line.x_signal_id,
      y_signal_ids: line.y_signal_ids,
      levels: line.levels.map((level) => ({
        level: level.level,
        anchor: Float64Array.from(level.anchor),
        x: column(level.x),
        ys: level.ys.map(column),
      })),
    })),
    histograms: wire.histograms ?? null,
  };
}
