import type { PlotInteractionPolicy } from "./plot-capabilities";
import type { AxisScale, Range, ZoomDragMode } from "./plot-math";

type StoredRanges = {
  x: readonly [number, number] | null;
  y: readonly [number, number] | null;
};

type AutomaticRanges = {
  x: readonly [number, number] | null;
  y: readonly [number, number] | null;
};

type AxisSelection = { x: boolean; y: boolean };
type Modifiers = { shift: boolean; alt: boolean };
type DragModifiers = { ctrl: boolean; meta: boolean };

export function wheelAxes(
  policy: PlotInteractionPolicy,
  modifiers: Modifiers,
): AxisSelection {
  if (modifiers.shift) {
    return { x: false, y: policy.zoom.has("y") };
  }
  if (modifiers.alt) {
    return { x: policy.zoom.has("x"), y: false };
  }
  return {
    x: policy.zoom.has("x"),
    y: policy.zoom.has("y"),
  };
}

export function panAxes(policy: PlotInteractionPolicy): AxisSelection {
  return {
    x: policy.pan.has("x"),
    y: policy.pan.has("y"),
  };
}

export function boxZoomAxes(
  policy: PlotInteractionPolicy,
  mode: ZoomDragMode,
): AxisSelection {
  if (!policy.zoom.has("box")) return { x: false, y: false };
  return {
    x: mode !== "y" && policy.zoom.has("x"),
    y: mode !== "x" && policy.zoom.has("y"),
  };
}

export function dragIntent(
  policy: PlotInteractionPolicy,
  button: number,
  modifiers: DragModifiers,
): "pan" | "box" | "click" | "none" {
  const panBinding =
    button === 1 ||
    button === 2 ||
    (button === 0 && (modifiers.ctrl || modifiers.meta));
  const pan = panAxes(policy);
  if (panBinding && (pan.x || pan.y)) return "pan";
  if (button !== 0) return "none";
  const box = boxZoomAxes(policy, "xy");
  return box.x || box.y ? "box" : "click";
}

export function allowsFit(policy: PlotInteractionPolicy): boolean {
  return policy.fit;
}

export function resolveRanges(
  policy: PlotInteractionPolicy,
  stored: StoredRanges,
  automatic: AutomaticRanges,
  window: { t0: number; t1: number },
  scales: { x?: AxisScale | null; y?: AxisScale | null } = {},
): { x: Range; y: Range } | null {
  let x =
    policy.xAxis === "linked-time"
      ? tupleRange([window.t0, window.t1])
      : tupleRange(stored.x ?? automatic.x);
  let y = tupleRange(stored.y ?? automatic.y);
  const positive = (
    range: Range | null,
    automatic: readonly [number, number] | null,
  ): Range => {
    if (range !== null && range.min > 0) return range;
    if (range !== null && range.max > 0) {
      const min = automatic?.[0] ?? range.max / 1000;
      if (min > 0 && min < range.max) return { min, max: range.max };
    }
    return tupleRange(automatic) ?? { min: 1, max: 10 };
  };
  if (scales.x === "log") x = positive(x, automatic.x);
  if (scales.y === "log") y = positive(y, automatic.y);
  if (scales.x === "log" || scales.y === "log") {
    x ??= { min: 0, max: 1 };
    y ??= { min: 0, max: 1 };
  }
  return x === null || y === null ? null : { x, y };
}

function tupleRange(range: readonly [number, number] | null): Range | null {
  if (range === null) return null;
  const [min, max] = range;
  return Number.isFinite(min) && Number.isFinite(max) && min < max
    ? { min, max }
    : null;
}
