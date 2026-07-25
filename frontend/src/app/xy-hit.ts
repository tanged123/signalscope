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
  let best: XyHit | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const entry of traces) {
    const { trace } = entry;
    for (let index = 0; index < trace.time.length; index += 1) {
      const x = trace.x[index] ?? Number.NaN;
      const y = trace.y[index] ?? Number.NaN;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const distance = Math.hypot(
        projectX(layout, x) - px,
        projectY(layout, y) - py,
      );
      if (distance >= bestDistance) continue;
      bestDistance = distance;
      best = {
        path: entry.path,
        index,
        time: trace.time[index] ?? Number.NaN,
        x,
        y,
      };
    }
  }
  return bestDistance <= maxDistance ? best : null;
}
