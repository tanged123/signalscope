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
