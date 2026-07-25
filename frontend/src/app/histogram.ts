export interface Histogram {
  /** `bins + 1` shared edges, ascending. */
  edges: number[];
  /** One count array per input column, each `edges.length - 1` long. */
  counts: number[][];
}

const MIN_BINS = 8;
const MAX_BINS = 128;

function quantile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return Number.NaN;
  const position = (sorted.length - 1) * fraction;
  const low = Math.floor(position);
  const high = Math.min(sorted.length - 1, low + 1);
  const alpha = position - low;
  return (
    (sorted[low] ?? 0) + ((sorted[high] ?? 0) - (sorted[low] ?? 0)) * alpha
  );
}

/**
 * Freedman–Diaconis bin count, falling back to Sturges when the
 * interquartile range collapses (heavily tied data), clamped to a range
 * that stays legible in a panel. ADR 0018.
 */
function binCount(sorted: readonly number[], min: number, max: number): number {
  const count = sorted.length;
  const iqr = quantile(sorted, 0.75) - quantile(sorted, 0.25);
  const width = iqr > 0 ? (2 * iqr) / Math.cbrt(count) : 0;
  const bins =
    width > 0
      ? Math.ceil((max - min) / width)
      : Math.ceil(Math.log2(Math.max(2, count))) + 1;
  return Math.min(MAX_BINS, Math.max(MIN_BINS, bins));
}

/**
 * Counts each column into shared bins spanning the union of their finite
 * values. Null when no column holds a finite value.
 */
export function histogram(
  columns: readonly (readonly number[])[],
): Histogram | null {
  const finite = columns.map((column) =>
    [...column].filter((value) => Number.isFinite(value)),
  );
  const pooled = finite.flat().sort((left, right) => left - right);
  if (pooled.length === 0) return null;
  let min = pooled[0] ?? 0;
  let max = pooled[pooled.length - 1] ?? 0;
  if (min === max) {
    min -= 0.5;
    max += 0.5;
  }
  const bins = binCount(pooled, min, max);
  const step = (max - min) / bins;
  const edges = Array.from(
    { length: bins + 1 },
    (_, index) => min + step * index,
  );
  const counts = finite.map((column) => {
    const row = new Array<number>(bins).fill(0);
    for (const value of column) {
      const slot = Math.min(bins - 1, Math.floor((value - min) / step));
      if (slot >= 0) row[slot] = (row[slot] ?? 0) + 1;
    }
    return row;
  });
  return { edges, counts };
}
