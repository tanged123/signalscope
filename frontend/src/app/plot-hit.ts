import {
  HAS_FIRST,
  HAS_GAP,
  HAS_LAST,
  HAS_MAX,
  HAS_MIN,
  type BinColumns,
} from "./bin-columns";
import { invertX, projectX, projectY, type PlotLayout } from "./plot-math";

export interface HitSeries {
  path: string;
  bins: BinColumns;
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
  const minTime = Math.min(
    invertX(layout, px - threshold),
    invertX(layout, px + threshold),
  );
  const maxTime = Math.max(
    invertX(layout, px - threshold),
    invertX(layout, px + threshold),
  );
  for (const entry of series) {
    const start = firstCenterAtOrAfter(entry.bins, minTime);
    const end = firstCenterAfter(entry.bins, maxTime);
    const firstIndex = Math.max(0, start - 1);
    const lastIndex = Math.min(entry.bins.count, end + 1);
    let previous: { x: number; y: number; time: number; value: number } | null =
      null;
    for (let index = firstIndex; index < lastIndex; index += 1) {
      const flags = entry.bins.flags[index] as number;
      const time =
        ((entry.bins.t0[index] as number) + (entry.bins.t1[index] as number)) *
        0.5;
      let first: { x: number; y: number; time: number; value: number } | null =
        null;
      const consider = (value: number | null): void => {
        if (value === null || !Number.isFinite(value)) {
          first = null;
          previous = null;
          return;
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
      };
      consider(flags & HAS_FIRST ? (entry.bins.first[index] as number) : null);
      consider(flags & HAS_MIN ? (entry.bins.min[index] as number) : null);
      consider(flags & HAS_MAX ? (entry.bins.max[index] as number) : null);
      consider(flags & HAS_LAST ? (entry.bins.last[index] as number) : null);
      if (flags & HAS_GAP) previous = null;
    }
  }
  return best;
}

function firstCenterAtOrAfter(bins: BinColumns, time: number): number {
  let low = 0;
  let high = bins.count;
  while (low < high) {
    const middle = (low + high) >> 1;
    const center =
      ((bins.t0[middle] as number) + (bins.t1[middle] as number)) * 0.5;
    if (center < time) low = middle + 1;
    else high = middle;
  }
  return low;
}

function firstCenterAfter(bins: BinColumns, time: number): number {
  let low = 0;
  let high = bins.count;
  while (low < high) {
    const middle = (low + high) >> 1;
    const center =
      ((bins.t0[middle] as number) + (bins.t1[middle] as number)) * 0.5;
    if (center <= time) low = middle + 1;
    else high = middle;
  }
  return low;
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
  // Ranked on squared distance — two vertices per bin over the bins the
  // cursor neighborhood can reach — then the winner's true distance is
  // reported once. The bracket keeps the scan independent of how much
  // padded data sits outside the view.
  let best: { path: string; time: number; value: number } | null = null;
  let bestSquared = threshold * threshold;
  const minTime = Math.min(
    invertX(layout, px - threshold),
    invertX(layout, px + threshold),
  );
  const maxTime = Math.max(
    invertX(layout, px - threshold),
    invertX(layout, px + threshold),
  );
  for (const entry of series) {
    const start = firstCenterAtOrAfter(entry.bins, minTime);
    const end = firstCenterAfter(entry.bins, maxTime);
    const firstIndex = Math.max(0, start - 1);
    const lastIndex = Math.min(entry.bins.count, end + 1);
    for (let index = firstIndex; index < lastIndex; index += 1) {
      const flags = entry.bins.flags[index] as number;
      const points = [
        [entry.bins.t0[index] as number, entry.bins.first[index] as number],
        [entry.bins.t1[index] as number, entry.bins.last[index] as number],
      ] as const;
      for (const [time, value, present] of [
        [points[0][0], points[0][1], Boolean(flags & HAS_FIRST)],
        [points[1][0], points[1][1], Boolean(flags & HAS_LAST)],
      ] as const) {
        if (!present || !Number.isFinite(value)) continue;
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
