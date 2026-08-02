import type { EnvelopeBin } from "../generated/protocol";
import { projectX, projectY, type PlotLayout } from "./plot-math";

export interface HitSeries {
  path: string;
  bins: readonly EnvelopeBin[];
}

export interface VertexHit {
  path: string;
  time: number;
  value: number;
  distance: number;
}

export interface LineHit {
  path: string;
  time: number;
  value: number;
  distance: number;
}

/** Finds the nearest rendered envelope segment in pixel space. */
export function nearestLine(
  series: readonly HitSeries[],
  layout: PlotLayout,
  px: number,
  py: number,
  threshold: number,
): LineHit | null {
  let best: LineHit | null = null;
  let bestSquared = threshold * threshold;
  for (const entry of series) {
    let previous: { x: number; y: number; time: number; value: number } | null =
      null;
    for (const bin of entry.bins) {
      const time = (bin.t0 + bin.t1) * 0.5;
      const points = [bin.first, bin.min, bin.max, bin.last];
      let first: { x: number; y: number; time: number; value: number } | null =
        null;
      for (const value of points) {
        if (value === null || !Number.isFinite(value)) {
          first = null;
          previous = null;
          continue;
        }
        const current = {
          x: projectX(layout, time),
          y: projectY(layout, value),
          time,
          value,
        };
        if (first === null) first = current;
        if (previous !== null) {
          const hit = segmentHit(previous, current, px, py);
          if (hit.squared <= bestSquared) {
            bestSquared = hit.squared;
            best = {
              path: entry.path,
              time:
                previous.time + (current.time - previous.time) * hit.fraction,
              value:
                previous.value +
                (current.value - previous.value) * hit.fraction,
              distance: Math.sqrt(hit.squared),
            };
          }
        }
        previous = current;
      }
      if (bin.has_gap) previous = null;
    }
  }
  return best;
}

export function segmentHit(
  first: { x: number; y: number },
  second: { x: number; y: number },
  px: number,
  py: number,
): { squared: number; fraction: number } {
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  const lengthSquared = dx * dx + dy * dy;
  const fraction =
    lengthSquared === 0
      ? 0
      : Math.max(
          0,
          Math.min(
            1,
            ((px - first.x) * dx + (py - first.y) * dy) / lengthSquared,
          ),
        );
  const x = first.x + dx * fraction;
  const y = first.y + dy * fraction;
  return { squared: (x - px) ** 2 + (y - py) ** 2, fraction };
}

export function nearestVertex(
  series: readonly HitSeries[],
  layout: PlotLayout,
  px: number,
  py: number,
  threshold: number,
): VertexHit | null {
  // Ranked on squared distance — two vertices per bin over every visible bin
  // on each pointer move — then the winner's true distance is reported once.
  let best: { path: string; time: number; value: number } | null = null;
  let bestSquared = threshold * threshold;
  for (const entry of series) {
    for (const bin of entry.bins) {
      for (const [time, value] of [
        [bin.t0, bin.first],
        [bin.t1, bin.last],
      ] as const) {
        if (value === null) continue;
        const dx = projectX(layout, time) - px;
        const dy = projectY(layout, value) - py;
        const squared = dx * dx + dy * dy;
        if (squared > bestSquared) continue;
        // `<=` on the first candidate keeps a zero-threshold exact hit.
        if (best !== null && squared === bestSquared) continue;
        bestSquared = squared;
        best = { path: entry.path, time, value };
      }
    }
  }
  return best === null ? null : { ...best, distance: Math.sqrt(bestSquared) };
}
