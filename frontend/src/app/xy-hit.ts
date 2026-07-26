import { projectX, projectY, type PlotLayout } from "./plot-math";
import type { XyTrace } from "./xy";

export interface XyHit {
  path: string;
  index: number;
  time: number;
  x: number;
  y: number;
}

/**
 * The trajectory vertex closest to a pixel, in pixel space, or null when
 * nothing lies within `maxDistance`. Hovering a trajectory publishes the
 * hit's timestamp as the global cursor, which couples an XY panel to every
 * time panel.
 */
export function nearestXyPoint(
  traces: readonly { path: string; trace: XyTrace }[],
  layout: PlotLayout,
  px: number,
  py: number,
  maxDistance: number,
): XyHit | null {
  // Squared distances throughout: this runs over every vertex of every trace
  // on each hover, and only the ordering matters until the final compare.
  let bestTrace: { path: string; trace: XyTrace } | null = null;
  let bestIndex = -1;
  let bestSquared = Number.POSITIVE_INFINITY;
  for (const entry of traces) {
    const { trace } = entry;
    for (let index = 0; index < trace.time.length; index += 1) {
      const x = trace.x[index] ?? Number.NaN;
      const y = trace.y[index] ?? Number.NaN;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const dx = projectX(layout, x) - px;
      const dy = projectY(layout, y) - py;
      const squared = dx * dx + dy * dy;
      if (squared >= bestSquared) continue;
      bestSquared = squared;
      bestTrace = entry;
      bestIndex = index;
    }
  }
  if (bestTrace === null || bestSquared > maxDistance * maxDistance) {
    return null;
  }
  const { trace } = bestTrace;
  return {
    path: bestTrace.path,
    index: bestIndex,
    time: trace.time[bestIndex] ?? Number.NaN,
    x: trace.x[bestIndex] ?? Number.NaN,
    y: trace.y[bestIndex] ?? Number.NaN,
  };
}
