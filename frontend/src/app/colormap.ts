/**
 * Custom-property names of the sequential ramp, low to high. The ramp is
 * `batlow` (ADR 0016) and is theme-invariant: a sequential map's monotone
 * lightness is the property that makes it admissible, so re-stepping it per
 * surface the way categorical slots are re-stepped would destroy it.
 */
export const SEQ_TOKENS = [
  "--seq-01",
  "--seq-02",
  "--seq-03",
  "--seq-04",
  "--seq-05",
  "--seq-06",
  "--seq-07",
  "--seq-08",
  "--seq-09",
  "--seq-10",
  "--seq-11",
  "--seq-12",
  "--seq-13",
  "--seq-14",
  "--seq-15",
  "--seq-16",
] as const;

function channels(hex: string): [number, number, number] {
  const body = hex.trim().replace("#", "");
  const parts = [0, 2, 4].map((offset) =>
    Number.parseInt(body.slice(offset, offset + 2), 16),
  );
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function hex(value: number): string {
  return Math.round(Math.min(255, Math.max(0, value)))
    .toString(16)
    .padStart(2, "0");
}

/** Samples a hex ramp at `t ∈ [0, 1]`, clamping outside and on NaN. */
export function sampleColormap(stops: readonly string[], t: number): string {
  const first = stops[0] ?? "#000000";
  if (stops.length === 0) return first;
  if (!Number.isFinite(t)) return first;
  const position = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const low = Math.floor(position);
  const high = Math.min(stops.length - 1, low + 1);
  const alpha = position - low;
  const [r0, g0, b0] = channels(stops[low] ?? first);
  const [r1, g1, b1] = channels(stops[high] ?? first);
  return `#${hex(r0 + (r1 - r0) * alpha)}${hex(g0 + (g1 - g0) * alpha)}${hex(
    b0 + (b1 - b0) * alpha,
  )}`;
}
