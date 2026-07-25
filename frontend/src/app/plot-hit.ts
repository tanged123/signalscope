import type { EnvelopeBin } from "../generated/protocol";
import type { Annotation } from "../generated/session";
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

export function nearestVertex(
  series: readonly HitSeries[],
  layout: PlotLayout,
  px: number,
  py: number,
  threshold: number,
): VertexHit | null {
  let best: VertexHit | null = null;
  for (const entry of series) {
    for (const bin of entry.bins) {
      for (const [time, value] of [
        [bin.t0, bin.first],
        [bin.t1, bin.last],
      ] as const) {
        if (value === null) continue;
        const distance = Math.hypot(
          projectX(layout, time) - px,
          projectY(layout, value) - py,
        );
        if (
          distance <= threshold &&
          (best === null || distance < best.distance)
        ) {
          best = { path: entry.path, time, value, distance };
        }
      }
    }
  }
  return best;
}

export function nearestAnnotation(
  annotations: readonly Annotation[],
  layout: PlotLayout,
  px: number,
  py: number,
  threshold: number,
): string | null {
  let bestId: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const annotation of annotations) {
    const distance = Math.hypot(
      projectX(layout, annotation.time) - px,
      projectY(layout, annotation.value) - py,
    );
    if (distance <= threshold && distance < bestDistance) {
      bestId = annotation.id;
      bestDistance = distance;
    }
  }
  return bestId;
}
