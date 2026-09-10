import type { EnvelopeBin } from "../generated/protocol";

export interface Range {
  min: number;
  max: number;
}

interface PlotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type { AxisScale } from "../generated/session";
import type { AxisScale } from "../generated/session";

export interface PlotLayout {
  axisEqual?: boolean;
  plot: PlotRect;
  xRange: Range;
  yRange: Range;
  /** Absent means linear; non-positive log coordinates are not drawable. */
  xScale?: AxisScale;
  yScale?: AxisScale;
  xReversed?: boolean;
  yReversed?: boolean;
}

function logSpace(value: number): number {
  return value > 0 ? Math.log10(value) : NaN;
}

export function axisCoordinate(
  value: number,
  scale?: AxisScale | null,
): number {
  return scale === "log" ? logSpace(value) : value;
}

export function axisValue(value: number, scale?: AxisScale | null): number {
  return scale === "log" ? 10 ** value : value;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Fraction of the data span added to each end of an automatic extent. */
const EXTENT_PADDING = 0.06;

/**
 * The display extent for a data range: padded by a fixed fraction of its
 * span, or widened by one unit when the range collapses to a single value.
 * Null when either bound is not finite.
 */
export function paddedExtent(
  min: number,
  max: number,
  scale?: AxisScale | null,
): [number, number] | null {
  if (scale === "log") {
    const extent = paddedExtent(logSpace(min), logSpace(max));
    return extent === null
      ? null
      : [
          Math.min(min, Math.max(Number.MIN_VALUE, 10 ** extent[0])),
          Math.max(max, Math.min(Number.MAX_VALUE, 10 ** extent[1])),
        ];
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (min === max) return [min - 1, max + 1];
  const padding = (max - min) * EXTENT_PADDING;
  return [min - padding, max + padding];
}

export function projectX(layout: PlotLayout, value: number): number {
  const { plot, xRange } = layout;
  const min = axisCoordinate(xRange.min, layout.xScale);
  const max = axisCoordinate(xRange.max, layout.xScale);
  const fraction = (axisCoordinate(value, layout.xScale) - min) / (max - min);
  return (
    plot.x + (layout.xReversed === true ? 1 - fraction : fraction) * plot.width
  );
}

export function projectY(layout: PlotLayout, value: number): number {
  const { plot, yRange } = layout;
  const min = axisCoordinate(yRange.min, layout.yScale);
  const max = axisCoordinate(yRange.max, layout.yScale);
  const fraction = (axisCoordinate(value, layout.yScale) - min) / (max - min);
  return (
    plot.y + (layout.yReversed === true ? fraction : 1 - fraction) * plot.height
  );
}

export function invertX(layout: PlotLayout, px: number): number {
  const { plot, xRange } = layout;
  const min = axisCoordinate(xRange.min, layout.xScale);
  const max = axisCoordinate(xRange.max, layout.xScale);
  const fraction = (px - plot.x) / plot.width;
  return axisValue(
    min + (layout.xReversed === true ? 1 - fraction : fraction) * (max - min),
    layout.xScale,
  );
}

/** Decade ticks covering `[min, max]`, empty when the range is unusable. */
export function logTicks(min: number, max: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= 0) return [];
  const low = Math.floor(Math.log10(Math.max(Number.MIN_VALUE, min)));
  const high = Math.ceil(Math.log10(max));
  const values: number[] = [];
  for (let exponent = low; exponent <= high; exponent += 1) {
    const value = 10 ** exponent;
    if (value >= min * 0.999 && value <= max * 1.001) values.push(value);
  }
  return values;
}

export function invertY(layout: PlotLayout, py: number): number {
  const { plot, yRange } = layout;
  const min = axisCoordinate(yRange.min, layout.yScale);
  const max = axisCoordinate(yRange.max, layout.yScale);
  const fraction = (plot.y + plot.height - py) / plot.height;
  return axisValue(
    min + (layout.yReversed === true ? 1 - fraction : fraction) * (max - min),
    layout.yScale,
  );
}

export function insidePlot(
  layout: PlotLayout,
  px: number,
  py: number,
): boolean {
  const { plot } = layout;
  return (
    px >= plot.x &&
    px <= plot.x + plot.width &&
    py >= plot.y &&
    py <= plot.y + plot.height
  );
}

export function wheelZoomFactor(deltaY: number): number {
  return Math.exp(deltaY * 0.0016);
}

export function zoomRange(range: Range, factor: number, pivot: number): Range {
  const min = pivot + (range.min - pivot) * factor;
  const max = pivot + (range.max - pivot) * factor;
  const floor = Math.max(Math.abs(min), Math.abs(max), 1) * Number.EPSILON * 4;
  if (!Number.isFinite(min) || !Number.isFinite(max) || max - min <= floor) {
    return { min: range.min, max: range.max };
  }
  return { min, max };
}

export function panRange(range: Range, delta: number): Range {
  return { min: range.min + delta, max: range.max + delta };
}

/** Zooms an axis in its authored coordinate system (linear or log10). */
export function zoomScaledRange(
  range: Range,
  factor: number,
  pivot: number,
  scale: AxisScale = "linear",
): Range {
  if (scale !== "log") return zoomRange(range, factor, pivot);
  const next = zoomRange(
    { min: logSpace(range.min), max: logSpace(range.max) },
    factor,
    logSpace(pivot),
  );
  return finiteLogRange(next, range);
}

/** Zooms around the visual midpoint, including on logarithmic axes. */
export function zoomCenteredRange(
  range: Range,
  factor: number,
  scale: AxisScale = "linear",
): Range {
  const pivot = axisValue(
    (axisCoordinate(range.min, scale) + axisCoordinate(range.max, scale)) / 2,
    scale,
  );
  return zoomScaledRange(range, factor, pivot, scale);
}

/** Pans by a fraction of the displayed span, preserving log positivity. */
export function panScaledRange(
  range: Range,
  fraction: number,
  scale: AxisScale = "linear",
): Range {
  if (scale !== "log") {
    return panRange(range, fraction * (range.max - range.min));
  }
  const logarithmic = { min: logSpace(range.min), max: logSpace(range.max) };
  const delta = fraction * (logarithmic.max - logarithmic.min);
  const next = panRange(logarithmic, delta);
  return finiteLogRange(next, range);
}

function finiteLogRange(next: Range, fallback: Range): Range {
  const min = 10 ** next.min;
  const max = 10 ** next.max;
  return min > 0 && Number.isFinite(max) && min < max
    ? { min, max }
    : { ...fallback };
}

export type ZoomDragMode = "x" | "y" | "xy";

/** Axis-only for thin/extreme drags; ordinary rectangles retain box zoom. */
export function zoomDragMode(deltaX: number, deltaY: number): ZoomDragMode {
  const width = Math.abs(deltaX);
  const height = Math.abs(deltaY);
  if (width <= 8 && height > 8) return "y";
  if (height <= 8 && width > 8) return "x";
  if (width >= height * 3) return "x";
  if (height >= width * 3) return "y";
  return "xy";
}

export function valueAtTime(
  bins: readonly EnvelopeBin[],
  time: number,
): number | null {
  if (bins.length === 0) return null;
  const center = (bin: EnvelopeBin): number => (bin.t0 + bin.t1) * 0.5;
  let low = 0;
  let high = bins.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (center(bins[mid] as EnvelopeBin) < time) low = mid + 1;
    else high = mid;
  }
  const next = bins[low];
  if (next === undefined) return null;
  const nextCenter = center(next);
  if (time >= next.t0 && time <= next.t1 && next.t1 > next.t0) {
    if (next.first === null || next.last === null) return null;
    const alpha = (time - next.t0) / (next.t1 - next.t0);
    return next.first + (next.last - next.first) * alpha;
  }
  if (time === nextCenter) return next.last;
  const previous = bins[low - 1];
  if (
    previous === undefined ||
    previous.last === null ||
    next.first === null ||
    next.has_gap
  ) {
    return null;
  }
  const previousCenter = center(previous);
  if (
    time < previousCenter ||
    time > nextCenter ||
    nextCenter <= previousCenter
  ) {
    return null;
  }
  const alpha = (time - previousCenter) / (nextCenter - previousCenter);
  return previous.last + (next.first - previous.last) * alpha;
}

const MINUS = "−";

export function formatValue(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "—";
  const magnitude = Math.abs(value);
  const text =
    magnitude >= 1e6 || (magnitude > 0 && magnitude < 1e-3)
      ? value.toExponential(3)
      : value.toFixed(4);
  return text.replace("-", MINUS).replace(`e${MINUS}`, "e-");
}

export function formatCursorTime(time: number): string {
  return `${time.toFixed(4).replace("-", MINUS)} s`;
}
