import {
  HAS_FIRST,
  HAS_GAP,
  HAS_LAST,
  HAS_MAX,
  HAS_MIN,
  type BinColumns,
} from "../app/bin-columns";

const EXTREMA = HAS_FIRST | HAS_LAST | HAS_MIN | HAS_MAX;

export interface DensityGrid {
  coverage: Float32Array;
  width: number;
  height: number;
}

/**
 * Rasterizes one series' envelope into the coverage grid as connected
 * trapezoids between consecutive bins' [min, max] spans. Isolated columns
 * are exactly the comb artifact this tier exists to remove, so bins connect
 * whenever the stroke path would connect them, and break where it lifts the
 * pen: a gap flag or missing extrema. Each cell receives at most +1 per
 * series — a bin's own column is filled when it starts a run, and the
 * trapezoid to a successor covers (previous, current], so seams never
 * double-count.
 */
export function accumulateEnvelope(
  grid: DensityGrid,
  bins: BinColumns,
  toColumn: (t: number) => number,
  toRow: (value: number) => number,
): void {
  const { coverage, width, height } = grid;
  const { t0, t1, min, max, flags, count } = bins;
  const fillColumn = (x: number, rowA: number, rowB: number): void => {
    const column = Math.round(x);
    if (column < 0 || column >= width) return;
    const top = Math.max(0, Math.floor(Math.min(rowA, rowB)));
    const bottom = Math.min(height - 1, Math.ceil(Math.max(rowA, rowB)));
    for (let row = top; row <= bottom; row += 1) {
      const offset = row * width + column;
      coverage[offset] = (coverage[offset] ?? 0) + 1;
    }
  };
  let previous: { x: number; lo: number; hi: number } | null = null;
  for (let index = 0; index < count; index += 1) {
    const binFlags = flags[index] as number;
    if ((binFlags & EXTREMA) !== EXTREMA) {
      previous = null;
      continue;
    }
    const x = toColumn(((t0[index] as number) + (t1[index] as number)) * 0.5);
    const lo = toRow(min[index] as number);
    const hi = toRow(max[index] as number);
    const gap = (binFlags & HAS_GAP) !== 0;
    if (previous === null || gap || x <= previous.x) {
      fillColumn(x, lo, hi);
    } else {
      // The previous bin's column is already covered; fill (previous, x].
      const from = Math.max(0, Math.round(previous.x) + 1);
      const to = Math.min(width - 1, Math.round(x));
      const span = x - previous.x;
      for (let column = from; column <= to; column += 1) {
        const t = Math.min(1, Math.max(0, (column - previous.x) / span));
        const bandLo = previous.lo + (lo - previous.lo) * t;
        const bandHi = previous.hi + (hi - previous.hi) * t;
        fillColumn(column, bandLo, bandHi);
      }
    }
    previous = gap ? null : { x, lo, hi };
  }
}

/** `#rgb` / `#rrggbb`; anything else falls back to neutral grey. */
export function parseHexColor(color: string): {
  r: number;
  g: number;
  b: number;
} {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)?.[1];
  if (hex === undefined) return { r: 128, g: 128, b: 128 };
  if (hex.length === 3) {
    return {
      r: parseInt((hex[0] ?? "0") + (hex[0] ?? "0"), 16),
      g: parseInt((hex[1] ?? "0") + (hex[1] ?? "0"), 16),
      b: parseInt((hex[2] ?? "0") + (hex[2] ?? "0"), 16),
    };
  }
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

/**
 * Coverage -> straight-alpha RGBA. A cell k series deep composites to the
 * alpha k overlapping translucent strokes would produce:
 * `1 - (1 - pointAlpha)^k`. This is the law xy's field capture validated —
 * a per-window normalized tone curve reads lighter or darker than the very
 * strokes it aggregates. Zero coverage stays transparent so grid lines and
 * background show through the drawImage blend.
 */
export function coverageToImage(
  grid: DensityGrid,
  color: string,
  pointAlpha: number,
): Uint8ClampedArray {
  const { coverage, width, height } = grid;
  const { r, g, b } = parseHexColor(color);
  const keep = 1 - pointAlpha;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < coverage.length; index += 1) {
    const k = coverage[index] ?? 0;
    if (k <= 0) continue;
    const alpha = 1 - Math.pow(keep, k);
    const offset = index * 4;
    pixels[offset] = r;
    pixels[offset + 1] = g;
    pixels[offset + 2] = b;
    pixels[offset + 3] = Math.round(alpha * 255);
  }
  return pixels;
}
