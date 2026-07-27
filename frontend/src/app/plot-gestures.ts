import type { PlotInteractionPolicy } from "./plot-capabilities";
import type { Range } from "./plot-math";

type StoredRanges = {
  x: readonly [number, number] | null;
  y: readonly [number, number] | null;
};

type AutomaticRanges = {
  x: readonly [number, number] | null;
  y: readonly [number, number] | null;
};

export function resolveRanges(
  policy: PlotInteractionPolicy,
  stored: StoredRanges,
  automatic: AutomaticRanges,
  window: { t0: number; t1: number },
): { x: Range; y: Range } | null {
  const x =
    policy.xAxis === "linked-time"
      ? tupleRange([window.t0, window.t1])
      : tupleRange(stored.x ?? automatic.x);
  const y = tupleRange(stored.y ?? automatic.y);
  return x === null || y === null ? null : { x, y };
}

function tupleRange(range: readonly [number, number] | null): Range | null {
  if (range === null) return null;
  const [min, max] = range;
  return Number.isFinite(min) && Number.isFinite(max) && min < max
    ? { min, max }
    : null;
}
