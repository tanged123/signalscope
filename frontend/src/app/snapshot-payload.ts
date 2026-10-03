import type {
  BakedHistogram,
  BakedLevel,
  EnvelopeBin,
  SignalSummary,
  SnapshotManifest,
} from "../generated/protocol";
import {
  binColumnsFromWire,
  HAS_FIRST,
  HAS_GAP,
  HAS_LAST,
  HAS_MAX,
  HAS_MIN,
  type BinColumns,
} from "./bin-columns";
import { open, type Envelope } from "./envelope";

/** One baked pyramid level. Bin columns are built on first use. */
export interface BakedLevelData {
  readonly count: number;
  readonly t0: Float64Array;
  readonly t1: Float64Array;
  columns(): BinColumns;
}

export interface BakedSignalData {
  readonly summary: SignalSummary;
  readonly levels: readonly BakedLevelData[];
}

export interface BakedLineLevelData {
  readonly level: number;
  readonly anchor: Float64Array;
  /** Missing values are NaN. */
  readonly x: Float64Array;
  readonly ys: readonly Float64Array[];
}

interface BakedLineData {
  readonly x_signal_id: string;
  readonly y_signal_ids: readonly string[];
  readonly levels: readonly BakedLineLevelData[];
}

export interface BakedSnapshot {
  readonly sessionJson: string;
  readonly preferencesJson: string | null;
  readonly signals: readonly BakedSignalData[];
  readonly line2d: readonly BakedLineData[];
  readonly histograms: readonly BakedHistogram[] | null;
}

type Column = Float64Array | Uint32Array | Uint8Array;
type ColumnKind = "f64" | "u32" | "u8";

/** Trailer kind codes, in order. */
const KINDS: readonly ColumnKind[] = ["f64", "u32", "u8"];
const WIDTH = { f64: 8, u32: 4, u8: 1 } as const;
const BIN_KINDS = [
  "f64",
  "f64",
  "f64",
  "f64",
  "f64",
  "f64",
  "f64",
  "f64",
  "u32",
  "u32",
  "u8",
] as const;
const SAMPLE_FLAGS = HAS_FIRST | HAS_LAST | HAS_MIN | HAS_MAX;

function invalid(reason: string): Error {
  return new Error(`Invalid snapshot payload: ${reason}`);
}

/**
 * Decodes a sealed snapshot manifest (ADR 0068). Every column reference is
 * validated before anything is returned, so a damaged payload never yields a
 * partial snapshot.
 */
export async function decodeSnapshot(
  envelope: Envelope<SnapshotManifest>,
): Promise<BakedSnapshot> {
  const manifest = open(envelope);
  const { kinds, columns } = readColumns(await inflate(manifest.payload));
  const take = (index: number, kind: ColumnKind): Column => {
    const column = columns[index];
    if (column === undefined || kinds[index] !== kind) {
      throw invalid(`column ${String(index)} is missing or not ${kind}`);
    }
    return column;
  };
  const f64 = (index: number) => take(index, "f64") as Float64Array;

  const signals = manifest.signals.map((signal) => ({
    summary: signal.summary,
    levels: signal.levels.map((level) => decodeLevel(level, take)),
  }));
  const line2d = (manifest.line2d ?? []).map((line) => ({
    x_signal_id: line.x_signal_id,
    y_signal_ids: line.y_signal_ids,
    levels: line.levels.map((level) => {
      const anchor = f64(level.anchor);
      const x = f64(level.x);
      const ys = level.ys.map(f64);
      if (
        x.length !== anchor.length ||
        ys.some((y) => y.length !== anchor.length)
      ) {
        throw invalid("Line2D columns differ in length");
      }
      return { level: level.level, anchor, x, ys };
    }),
  }));
  return {
    sessionJson: manifest.session_json,
    preferencesJson: manifest.preferences_json ?? null,
    signals,
    line2d,
    histograms: manifest.histograms ?? null,
  };
}

async function inflate(payload: string): Promise<Uint8Array> {
  let binary: string;
  try {
    binary = atob(payload);
  } catch {
    throw invalid("payload is not base64");
  }
  const compressed = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    compressed[index] = binary.charCodeAt(index);
  }
  try {
    const stream = new Blob([compressed])
      .stream()
      .pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    throw invalid("payload is not a deflate stream");
  }
}

/**
 * Splits the decompressed stream into typed columns using its trailing column
 * table: `[kind: u8; n] [element count: u32 LE; n] [n: u32 LE]`.
 */
function readColumns(bytes: Uint8Array): {
  kinds: ColumnKind[];
  columns: Column[];
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 4) throw invalid("column table is missing");
  const count = view.getUint32(bytes.length - 4, true);
  const tableStart = bytes.length - 4 - count * 5;
  if (tableStart < 0) throw invalid("column table is truncated");
  const kinds: ColumnKind[] = [];
  const columns: Column[] = [];
  let offset = 0;
  for (let index = 0; index < count; index += 1) {
    const kind = KINDS[bytes[tableStart + index] as number];
    if (kind === undefined)
      throw invalid(`column ${String(index)} has an unknown kind`);
    const width = WIDTH[kind];
    const length = view.getUint32(tableStart + count + index * 4, true);
    if (offset + length * width > tableStart) {
      throw invalid(`column ${String(index)} is out of bounds`);
    }
    kinds.push(kind);
    columns.push(unshuffle(bytes, offset, length, kind));
    offset += length * width;
  }
  if (offset !== tableStart) throw invalid("column data length mismatch");
  return { kinds, columns };
}

function unshuffle(
  bytes: Uint8Array,
  offset: number,
  count: number,
  kind: ColumnKind,
): Column {
  const width = WIDTH[kind];
  const out = new Uint8Array(count * width);
  for (let byte = 0; byte < width; byte += 1) {
    const source = offset + byte * count;
    for (let element = 0; element < count; element += 1) {
      out[element * width + byte] = bytes[source + element] as number;
    }
  }
  if (kind === "f64") return new Float64Array(out.buffer);
  if (kind === "u32") return new Uint32Array(out.buffer);
  return out;
}

function decodeLevel(
  level: BakedLevel,
  take: (index: number, kind: ColumnKind) => Column,
): BakedLevelData {
  if (level.encoding === "samples") {
    if (level.columns.length !== 2)
      throw invalid("sample level needs 2 columns");
    const time = take(level.columns[0] as number, "f64") as Float64Array;
    const values = take(level.columns[1] as number, "f64") as Float64Array;
    if (time.length !== values.length) {
      throw invalid("sample level columns differ in length");
    }
    return sampleLevel(time, values);
  }
  if (level.columns.length !== BIN_KINDS.length) {
    throw invalid("bin level needs 11 columns");
  }
  const c = level.columns.map((index, position) =>
    take(index, BIN_KINDS[position] as ColumnKind),
  );
  const count = (c[0] as Column).length;
  if (c.some((column) => column.length !== count)) {
    throw invalid("bin level columns differ in length");
  }
  const columns: BinColumns = {
    count,
    t0: c[0] as Float64Array,
    t1: c[1] as Float64Array,
    first: c[2] as Float64Array,
    last: c[3] as Float64Array,
    min: c[4] as Float64Array,
    max: c[5] as Float64Array,
    sum: c[6] as Float64Array,
    sumSq: c[7] as Float64Array,
    sampleCount: c[8] as unknown as Uint32Array,
    finiteCount: c[9] as unknown as Uint32Array,
    flags: c[10] as unknown as Uint8Array,
  };
  return { count, t0: columns.t0, t1: columns.t1, columns: () => columns };
}

/**
 * Single-sample bins exactly as `pyramid::synthesize` builds level zero:
 * non-finite values are gaps with zero sums.
 */
function sampleLevel(time: Float64Array, values: Float64Array): BakedLevelData {
  let columns: BinColumns | undefined;
  return {
    count: time.length,
    t0: time,
    t1: time,
    columns: () => {
      if (columns !== undefined) return columns;
      const count = time.length;
      const value = new Float64Array(count);
      const sum = new Float64Array(count);
      const sumSq = new Float64Array(count);
      const finiteCount = new Uint32Array(count);
      const flags = new Uint8Array(count);
      for (let index = 0; index < count; index += 1) {
        const v = values[index] as number;
        if (Number.isFinite(v)) {
          value[index] = v;
          sum[index] = v;
          sumSq[index] = v * v;
          finiteCount[index] = 1;
          flags[index] = SAMPLE_FLAGS;
        } else {
          value[index] = Number.NaN;
          flags[index] = HAS_GAP;
        }
      }
      columns = {
        count,
        t0: time,
        t1: time,
        first: value,
        last: value,
        min: value,
        max: value,
        sum,
        sumSq,
        sampleCount: new Uint32Array(count).fill(1),
        finiteCount,
        flags,
      };
      return columns;
    },
  };
}

/** A level whose bin columns already exist in memory. */
export function levelFromBins(bins: readonly EnvelopeBin[]): BakedLevelData {
  const columns = binColumnsFromWire(bins);
  return {
    count: columns.count,
    t0: columns.t0,
    t1: columns.t1,
    columns: () => columns,
  };
}
