import type { EnvelopeBin } from "../generated/protocol";

export interface Range {
  min: number;
  max: number;
}

export interface PlotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type AxisScale = "linear" | "log";

export interface PlotLayout {
  plot: PlotRect;
  xRange: Range;
  yRange: Range;
  /** Absent means linear. Log axes clamp non-positive values to the floor. */
  xScale?: AxisScale;
}

/** Positive floor used so a log axis can survive a zero or negative bound. */
const LOG_FLOOR = 1e-12;

function logSpace(value: number): number {
  return Math.log10(Math.max(LOG_FLOOR, value));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function projectX(layout: PlotLayout, value: number): number {
  const { plot, xRange } = layout;
  if (layout.xScale === "log") {
    const min = logSpace(xRange.min);
    const max = logSpace(xRange.max);
    return plot.x + ((logSpace(value) - min) / (max - min)) * plot.width;
  }
  return (
    plot.x + ((value - xRange.min) / (xRange.max - xRange.min)) * plot.width
  );
}

export function projectY(layout: PlotLayout, value: number): number {
  const { plot, yRange } = layout;
  return (
    plot.y +
    plot.height -
    ((value - yRange.min) / (yRange.max - yRange.min)) * plot.height
  );
}

export function invertX(layout: PlotLayout, px: number): number {
  const { plot, xRange } = layout;
  if (layout.xScale === "log") {
    const min = logSpace(xRange.min);
    const max = logSpace(xRange.max);
    return 10 ** (min + ((px - plot.x) / plot.width) * (max - min));
  }
  return xRange.min + ((px - plot.x) / plot.width) * (xRange.max - xRange.min);
}

/** Decade ticks covering `[min, max]`, empty when the range is unusable. */
export function logTicks(min: number, max: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= 0) return [];
  const low = Math.floor(Math.log10(Math.max(LOG_FLOOR, min)));
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
  return (
    yRange.min +
    ((plot.y + plot.height - py) / plot.height) * (yRange.max - yRange.min)
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
  return { min: 10 ** next.min, max: 10 ** next.max };
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
  return { min: 10 ** next.min, max: 10 ** next.max };
}

/**
 * The axis range that keeps two data anchors under two fingers.
 *
 * Solves the affine map `data = slope · pixel + intercept` through both
 * (pixel, anchor) pairs and evaluates it at the plot's edges, so a pinch is
 * zoom and pan in one continuous gesture. Null when the pinch is degenerate
 * (equal anchors, coincident fingers, or an inverted result).
 */
export function pinchRange(
  anchorA: number,
  anchorB: number,
  pixelA: number,
  pixelB: number,
  edgeLow: number,
  edgeHigh: number,
): Range | null {
  if (anchorA === anchorB || pixelA === pixelB) return null;
  const slope = (anchorB - anchorA) / (pixelB - pixelA);
  const intercept = anchorA - slope * pixelA;
  const first = slope * edgeLow + intercept;
  const second = slope * edgeHigh + intercept;
  const min = Math.min(first, second);
  const max = Math.max(first, second);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return null;
  }
  return { min, max };
}

/** Pinch range in linear or log10 coordinates. */
export function pinchScaledRange(
  anchorA: number,
  anchorB: number,
  pixelA: number,
  pixelB: number,
  edgeLow: number,
  edgeHigh: number,
  scale: AxisScale = "linear",
): Range | null {
  const next = pinchRange(
    scale === "log" ? logSpace(anchorA) : anchorA,
    scale === "log" ? logSpace(anchorB) : anchorB,
    pixelA,
    pixelB,
    edgeLow,
    edgeHigh,
  );
  if (next === null || scale !== "log") return next;
  return { min: 10 ** next.min, max: 10 ** next.max };
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
