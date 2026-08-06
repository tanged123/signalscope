import type { SeriesPathCallbacks } from "../../app/xy";
import { COLOR_SLOTS } from "../../render/canvas-renderer";
import { signalLabel } from "../dom";
import type { RenderSeries } from "../panel";

export function colorIndexForHue(hue: number | null): number {
  if (hue === null) return 0;
  return Math.max(0, Math.min(COLOR_SLOTS - 1, Math.trunc(hue) - 1));
}

export function visibleSources(
  series: readonly RenderSeries[],
  callbacks: SeriesPathCallbacks,
): Set<string> {
  return new Set(
    series
      .filter((entry) => entry.visible)
      .map((entry) => callbacks.sourceKeyFor(entry.path))
      .filter((key): key is string => key !== null),
  );
}

export function yLabel(units: readonly (string | null)[]): string {
  const distinct = new Set(
    units.filter((unit): unit is string => unit !== null),
  );
  const [only] = distinct;
  return distinct.size === 1 && only !== undefined
    ? `value (${only})`
    : "value";
}

/** `path/leaf (unit)` for an axis name, matching the spec's XY gutters. */
export function axisName(path: string, unit: string | null): string {
  const leaf = signalLabel(path);
  return unit === null ? leaf : `${leaf} (${unit})`;
}
