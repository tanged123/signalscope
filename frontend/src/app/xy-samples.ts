import type { SampleRequest, SampleResponse } from "../generated/protocol";
import { mergeSampleResponses } from "./samples";
import { SampleWindowCache } from "./sample-window-cache";

export interface SampleQueryPlane {
  querySamples(request: SampleRequest): Promise<SampleResponse>;
}

/** Fetch the full XY context once and a fresh detail response per window. */
export async function fetchXySamples(options: {
  plane: SampleQueryPlane;
  panelId: string;
  ids: readonly string[];
  cap: number;
  contextWindow: { t0: number; t1: number };
  window: { t0: number; t1: number };
  contextCache: SampleWindowCache;
}): Promise<SampleResponse> {
  const { plane, panelId, ids, cap, contextWindow, window, contextCache } =
    options;
  const contextKey = SampleWindowCache.key({
    ids,
    mode: "xy-context",
    window: contextWindow,
    cap,
  });
  const cachedContext = contextCache.get(panelId, contextKey);
  const contextPromise =
    cachedContext !== null
      ? Promise.resolve(cachedContext)
      : plane.querySamples({
          request_id: crypto.randomUUID(),
          signal_ids: [...ids],
          window: contextWindow,
          max_points: cap,
        });
  const detailPromise = plane.querySamples({
    request_id: crypto.randomUUID(),
    signal_ids: [...ids],
    window,
    max_points: cap,
  });
  const [context, detail] = await Promise.all([contextPromise, detailPromise]);
  contextCache.store(panelId, contextKey, context);
  return mergeSampleResponses(context, detail);
}
