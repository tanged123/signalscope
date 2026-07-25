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

export interface PlotLayout {
  plot: PlotRect;
  xRange: Range;
  yRange: Range;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function projectX(layout: PlotLayout, value: number): number {
  const { plot, xRange } = layout;
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
  return xRange.min + ((px - plot.x) / plot.width) * (xRange.max - xRange.min);
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

export function valueAtTime(
  bins: readonly EnvelopeBin[],
  time: number,
): number | null {
  if (bins.length === 0) return null;
  let low = 0;
  let high = bins.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((bins[mid]?.t1 ?? Number.NEGATIVE_INFINITY) < time) low = mid + 1;
    else high = mid;
  }
  const hit = bins[low];
  if (hit === undefined || time < hit.t0 || time > hit.t1) return null;
  if (hit.first === null || hit.last === null) return null;
  if (hit.t1 === hit.t0) return hit.last;
  const alpha = (time - hit.t0) / (hit.t1 - hit.t0);
  return hit.first + (hit.last - hit.first) * alpha;
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
