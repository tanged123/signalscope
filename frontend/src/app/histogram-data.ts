import type {
  BakedHistogram,
  HistogramRequest,
  HistogramResponse,
} from "../generated/protocol";

const U64_MAX = 18446744073709551615n;

function exactCount(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(0|[1-9][0-9]{0,19})$/.test(value) &&
    BigInt(value) <= U64_MAX
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateHistogramResponse(
  value: unknown,
  request: HistogramRequest,
): HistogramResponse {
  const fail = (): never => {
    throw new Error("Invalid histogram response.");
  };
  if (
    !Number.isInteger(request.bin_count) ||
    request.bin_count < 1 ||
    request.bin_count > 256 ||
    !Number.isFinite(request.window.t0) ||
    !Number.isFinite(request.window.t1) ||
    request.window.t0 > request.window.t1 ||
    new Set(request.signal_ids).size !== request.signal_ids.length
  )
    fail();
  if (!record(value) || !record(value.window)) return fail();
  if (
    value.request_id !== request.request_id ||
    value.window.t0 !== request.window.t0 ||
    value.window.t1 !== request.window.t1 ||
    !Array.isArray(value.edges) ||
    !Array.isArray(value.series) ||
    value.series.length !== request.signal_ids.length
  )
    return fail();
  const edges: unknown[] = value.edges;
  if (edges.length !== 0 && edges.length !== request.bin_count + 1) fail();
  if (
    !edges.every(
      (edge, index) =>
        typeof edge === "number" &&
        Number.isFinite(edge) &&
        (index === 0 || edge > (edges[index - 1] as number)),
    )
  )
    fail();
  const ids = new Set<string>();
  const units = new Set<string | null>();
  const entries: unknown[] = value.series;
  for (const series of entries) {
    if (
      !record(series) ||
      !exactCount(series.signal_id) ||
      !request.signal_ids.includes(series.signal_id) ||
      ids.has(series.signal_id) ||
      typeof series.signal_path !== "string" ||
      !(series.unit === null || typeof series.unit === "string") ||
      !Array.isArray(series.counts) ||
      series.counts.length !== Math.max(0, edges.length - 1) ||
      !series.counts.every(exactCount) ||
      !exactCount(series.finite_count) ||
      !exactCount(series.excluded_count)
    )
      return fail();
    const counts = series.counts;
    const sum = counts.reduce((total, count) => total + BigInt(count), 0n);
    if (sum !== BigInt(series.finite_count)) fail();
    ids.add(series.signal_id);
    units.add(series.unit);
  }
  if (units.size > 1) fail();
  return value as unknown as HistogramResponse;
}

export function queryCapturedHistogram(
  captures: readonly BakedHistogram[],
  request: HistogramRequest,
): HistogramResponse {
  const capture = captures.find(
    (entry) =>
      entry.bin_count === request.bin_count &&
      entry.response.window.t0 === request.window.t0 &&
      entry.response.window.t1 === request.window.t1 &&
      entry.response.series.length === request.signal_ids.length &&
      entry.response.series.every((series) =>
        request.signal_ids.includes(series.signal_id),
      ),
  );
  if (capture === undefined)
    throw new Error(
      "This histogram was not captured. Open the original data to change its window, signals, or bins.",
    );
  return validateHistogramResponse(
    { ...capture.response, request_id: request.request_id },
    request,
  );
}

export function validateHistogramCaptures(
  value: unknown,
): readonly BakedHistogram[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("Invalid captured histograms.");
  const panels = new Set<string>();
  const entries: unknown[] = value;
  for (const entry of entries) {
    if (
      !record(entry) ||
      typeof entry.panel_id !== "string" ||
      panels.has(entry.panel_id) ||
      !Number.isInteger(entry.bin_count) ||
      !record(entry.response) ||
      !Array.isArray(entry.response.series) ||
      !record(entry.response.window) ||
      typeof entry.response.request_id !== "string"
    ) {
      throw new Error("Invalid captured histogram.");
    }
    const series: unknown[] = entry.response.series;
    const ids = series.map((item) =>
      record(item) && exactCount(item.signal_id) ? item.signal_id : "invalid",
    );
    validateHistogramResponse(entry.response, {
      request_id: entry.response.request_id,
      signal_ids: ids,
      window: {
        t0: Number(entry.response.window.t0),
        t1: Number(entry.response.window.t1),
      },
      bin_count: Number(entry.bin_count),
    });
    panels.add(entry.panel_id);
  }
  return value as BakedHistogram[];
}

export function histogramIdentity(
  request: Pick<HistogramRequest, "signal_ids" | "window" | "bin_count">,
): string {
  return JSON.stringify([
    [...request.signal_ids].sort(),
    request.window.t0,
    request.window.t1,
    request.bin_count,
  ]);
}

/** Includes decimal counts, step feeds and temporary response copies conservatively. */
export function histogramBytes(
  series: number,
  bins: number,
): { cpu: number; gpu: number } {
  return {
    cpu: (series * bins + bins + 1) * 128,
    gpu: series * (bins * 4 + 2) * 8,
  };
}
