import type { ResolvedPieSeriesConfig } from '../config/OptionResolver';

const TAU = Math.PI * 2;

const wrapToTau = (thetaRad: number): number => {
  if (!Number.isFinite(thetaRad)) return 0;
  const t = thetaRad % TAU;
  return t < 0 ? t + TAU : t;
};

export type PieSliceMatch = Readonly<{
  seriesIndex: number;
  dataIndex: number;
  slice: ResolvedPieSeriesConfig['data'][number];
}>;

export type PieHitTestConfig = Readonly<{
  seriesIndex: number;
  series: ResolvedPieSeriesConfig;
}>;

export type PieCenterCssPx = Readonly<{ x: number; y: number }>;
export type PieRadiusCssPx = Readonly<{ inner: number; outer: number }>;

/**
 * Finds the pie slice under a given pointer position.
 *
 * Coordinate contract:
 * - `x`/`y` are plot/grid-local CSS pixels (origin at plot top-left, +y down).
 * - `center` is plot-local CSS pixels.
 * - `radius` is CSS pixels (inner/outer). Points within the donut hole are not hoverable.
 *
 * Angle conventions:
 * - Uses +y up for polar angle (to match `pie.wgsl` atan2(p.y, p.x)).
 * - Wraps angles to [0, 2π).
 * - Matches `createPieRenderer.ts` start angle default (90°).
 *
 * Value conventions:
 * - Ignores non-finite and non-positive slice values (mirrors renderer).
 */
export function findPieSlice(
  x: number,
  y: number,
  pieConfig: PieHitTestConfig,
  center: PieCenterCssPx,
  radius: PieRadiusCssPx
): PieSliceMatch | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (!Number.isFinite(center.x) || !Number.isFinite(center.y)) return null;

  const inner = Number.isFinite(radius.inner) ? Math.max(0, radius.inner) : 0;
  const outer = Number.isFinite(radius.outer) ? Math.max(0, radius.outer) : 0;
  if (!(outer > 0)) return null;

  // Polar coordinates:
  // - Pointer `y` is down in CSS px, but shader uses +y up (atan2(p.y, p.x)).
  const dx = x - center.x;
  const dyUp = center.y - y;
  const r = Math.hypot(dx, dyUp);
  if (!Number.isFinite(r)) return null;

  // Donut hole is non-hoverable; outer bound must be inside.
  if (r <= inner) return null;
  if (r > outer) return null;

  const angle = wrapToTau(Math.atan2(dyUp, dx));

  const series = pieConfig.series;
  const data = series.data;

  // Total positive value for angle allocation (mirrors renderer, exclude hidden slices).
  let total = 0;
  let validCount = 0;
  for (let i = 0; i < data.length; i++) {
    const item = data[i];
    const v = item?.value;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0 && item.visible !== false) {
      total += v;
      validCount++;
    }
  }
  if (!(total > 0) || validCount === 0) return null;

  const startDeg = typeof series.startAngle === 'number' && Number.isFinite(series.startAngle) ? series.startAngle : 90;
  let current = wrapToTau((startDeg * Math.PI) / 180);

  // Mirror renderer float-drift mitigation: force last slice to close the circle.
  let accumulated = 0;
  let emitted = 0;

  for (let i = 0; i < data.length; i++) {
    const slice = data[i];
    const v = slice?.value;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) continue;
    // Skip hidden slices
    if (slice?.visible === false) continue;

    emitted++;
    const isLast = emitted === validCount;

    const frac = v / total;
    let span = frac * TAU;
    if (isLast) {
      span = Math.max(0, TAU - accumulated);
    } else {
      span = Math.max(0, Math.min(TAU, span));
    }
    accumulated += span;
    if (!(span > 0)) continue;

    const start = current;
    // When there's only one visible slice, it should span the full circle (0 to TAU).
    // Don't wrap the end angle in this case, as wrapping (start + TAU) gives start again.
    const end = validCount === 1 ? current + TAU : wrapToTau(current + span);
    current = wrapToTau(current + span);

    // Match `pie.wgsl` wedge test (span and rel in [0, TAU) with wrap).
    let wedgeSpan = end - start;
    if (wedgeSpan < 0) wedgeSpan += TAU;

    let rel = angle - start;
    if (rel < 0) rel += TAU;

    if (rel <= wedgeSpan) {
      return { seriesIndex: pieConfig.seriesIndex, dataIndex: i, slice };
    }
  }

  return null;
}
