import type { SampleSeries } from "../generated/protocol";
import { HAS_FIRST, HAS_GAP, HAS_LAST, type ColumnarTile } from "./bin-columns";
import { paddedExtent } from "./plot-math";

/** One y signal paired onto an x signal's timebase. */
export interface XyTrace {
  time: number[];
  x: number[];
  y: number[];
}

function sameTimebase(
  left: readonly number[],
  right: readonly number[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Linear sample of `values` at `query`, NaN outside the signal's coverage.
 *
 * The prototype held the endpoint value flat past each end. This returns NaN
 * instead so the stroke lifts: an XY trajectory drawn past a signal's data is
 * a fabricated segment, and the pyramid's gap invariants already commit this
 * codebase to breaking strokes rather than bridging absent data.
 *
 * Exported because the spectrum module resamples the same way.
 */
export function lerpSample(
  time: readonly number[],
  values: readonly number[],
  query: number,
): number {
  const count = time.length;
  if (count === 0) return Number.NaN;
  if (query < (time[0] ?? 0) || query > (time[count - 1] ?? 0)) {
    return Number.NaN;
  }
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((time[mid] ?? 0) < query) low = mid + 1;
    else high = mid;
  }
  if ((time[low] ?? 0) === query) return values[low] ?? Number.NaN;
  const previous = Math.max(0, low - 1);
  const span = (time[low] ?? 0) - (time[previous] ?? 0);
  if (span === 0) return values[low] ?? Number.NaN;
  const alpha = (query - (time[previous] ?? 0)) / span;
  const before = values[previous] ?? Number.NaN;
  const after = values[low] ?? Number.NaN;
  return before + (after - before) * alpha;
}

/** Pairs `y` against `x` on the x signal's timebase. */
export function pairSamples(x: SampleSeries, y: SampleSeries): XyTrace {
  if (sameTimebase(x.time, y.time)) {
    return { time: [...x.time], x: [...x.values], y: [...y.values] };
  }
  return {
    time: [...x.time],
    x: [...x.values],
    y: x.time.map((time) => lerpSample(y.time, y.values, time)),
  };
}

/**
 * The padded display extent of one axis across every trace, restricted to
 * samples inside `[t0, t1]`. Null when nothing finite falls in the window.
 */
export function traceExtent(
  traces: readonly XyTrace[],
  axis: "x" | "y",
  t0: number,
  t1: number,
): [number, number] | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const trace of traces) {
    const column = axis === "x" ? trace.x : trace.y;
    for (let index = 0; index < trace.time.length; index += 1) {
      const time = trace.time[index] ?? Number.NaN;
      if (time < t0 || time > t1) continue;
      const value = column[index] ?? Number.NaN;
      if (!Number.isFinite(value)) continue;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  return paddedExtent(min, max);
}

/** The subset of panel callbacks needed for source-local pairing. */
export interface SeriesPathCallbacks {
  localPathFor(path: string): string | null;
  sourceKeyFor(path: string): string | null;
}

/** Map key for a series' source and local channel pair. */
export function seriesIndexKey(sourceKey: string, localPath: string): string {
  return `${sourceKey}\u0000${localPath}`;
}

/** Build the response-scoped source/local series lookup used by XY pairing. */
export function buildSeriesIndex(
  series: readonly SampleSeries[],
  callbacks: SeriesPathCallbacks,
): Map<string, SampleSeries> {
  const index = new Map<string, SampleSeries>();
  for (const entry of series) {
    const sourceKey = callbacks.sourceKeyFor(entry.signal_path);
    const localPath = callbacks.localPathFor(entry.signal_path);
    if (sourceKey === null || localPath === null) continue;
    const key = seriesIndexKey(sourceKey, localPath);
    if (!index.has(key)) index.set(key, entry);
  }
  return index;
}

const PAIR_FLAGS = HAS_FIRST | HAS_LAST;

/**
 * True when two tiles' buckets share one index space. On a shared time
 * array, equal level, count, and boundary timestamps identify corresponding
 * buckets without inspecting raw samples.
 */
export function tilesAligned(a: ColumnarTile, b: ColumnarTile): boolean {
  if (a.level !== b.level) return false;
  const ab = a.bins;
  const bb = b.bins;
  if (ab.count !== bb.count) return false;
  if (ab.count === 0) return true;
  const last = ab.count - 1;
  const middle = ab.count >> 1;
  return (
    ab.t0[0] === bb.t0[0] &&
    ab.t1[last] === bb.t1[last] &&
    ab.t0[middle] === bb.t0[middle]
  );
}

/**
 * Converts aligned envelope buckets into the existing XY trace shape.
 * First/last preserve sample correspondence; marginal extrema are not paired.
 * A gap or missing pair flags lifts the pen before the next valid point.
 */
export function pairTileTrace(
  x: ColumnarTile,
  y: ColumnarTile,
  color: ColumnarTile | null,
): { trace: XyTrace; colors: number[] | null } | null {
  if (!tilesAligned(x, y)) return null;
  if (color !== null && !tilesAligned(x, color)) return null;
  const time: number[] = [];
  const xs: number[] = [];
  const ys: number[] = [];
  const colors: number[] | null = color === null ? null : [];
  const count = x.bins.count;
  let penDown = false;
  const push = (t: number, xv: number, yv: number, cv: number): void => {
    time.push(t);
    xs.push(xv);
    ys.push(yv);
    colors?.push(cv);
  };
  for (let index = 0; index < count; index += 1) {
    const xFlags = x.bins.flags[index] as number;
    const yFlags = y.bins.flags[index] as number;
    if (
      (xFlags & PAIR_FLAGS) !== PAIR_FLAGS ||
      (yFlags & PAIR_FLAGS) !== PAIR_FLAGS
    ) {
      if (penDown) push(Number.NaN, Number.NaN, Number.NaN, Number.NaN);
      penDown = false;
      continue;
    }
    const gap = ((xFlags | yFlags) & HAS_GAP) !== 0;
    if (gap && penDown) {
      push(Number.NaN, Number.NaN, Number.NaN, Number.NaN);
    }
    const t0 = x.bins.t0[index] as number;
    const t1 = x.bins.t1[index] as number;
    const cFirst =
      color === null ? Number.NaN : (color.bins.first[index] as number);
    const cLast =
      color === null ? Number.NaN : (color.bins.last[index] as number);
    push(
      t0,
      x.bins.first[index] as number,
      y.bins.first[index] as number,
      cFirst,
    );
    const degenerate =
      t0 === t1 &&
      x.bins.first[index] === x.bins.last[index] &&
      y.bins.first[index] === y.bins.last[index];
    if (!degenerate) {
      push(
        t1,
        x.bins.last[index] as number,
        y.bins.last[index] as number,
        cLast,
      );
    }
    penDown = true;
  }
  return { trace: { time, x: xs, y: ys }, colors };
}

/** Tile analogue of buildSeriesIndex; first match wins. */
export function buildTileIndex(
  tiles: readonly ColumnarTile[],
  callbacks: SeriesPathCallbacks,
): Map<string, ColumnarTile> {
  const index = new Map<string, ColumnarTile>();
  for (const tile of tiles) {
    const sourceKey = callbacks.sourceKeyFor(tile.signalPath);
    const localPath = callbacks.localPathFor(tile.signalPath);
    if (sourceKey === null || localPath === null) continue;
    const key = seriesIndexKey(sourceKey, localPath);
    if (!index.has(key)) index.set(key, tile);
  }
  return index;
}
