import { expect, it, vi } from "vitest";
import { BakedPlane, HttpPlane } from "./data-plane";
import { seal } from "./envelope";
import type {
  HistogramRequest,
  HistogramResponse,
} from "../generated/protocol";

const request: HistogramRequest = {
  request_id: "h",
  signal_ids: ["1"],
  window: { t0: 0, t1: 2 },
  bin_count: 1,
};
const response: HistogramResponse = {
  request_id: "h",
  window: request.window,
  edges: [0, 1],
  series: [
    {
      signal_id: "1",
      signal_path: "run/v",
      unit: null,
      counts: ["9007199254740993"],
      finite_count: "9007199254740993",
      excluded_count: "1",
    },
  ],
};

it("posts the typed histogram request and forwards cancellation", async () => {
  const fetcher = vi.fn<typeof fetch>(() =>
    Promise.resolve(new Response(JSON.stringify(seal(response)))),
  );
  const plane = new HttpPlane(fetcher);
  const abort = new AbortController();
  expect(await plane.queryHistogram(request, abort.signal)).toEqual(response);
  expect(fetcher).toHaveBeenCalledWith(
    "/api/query_histogram",
    expect.objectContaining({
      signal: abort.signal,
      body: JSON.stringify(seal(request)),
    }),
  );
  fetcher.mockResolvedValueOnce(
    new Response(JSON.stringify(seal({ ...response, request_id: "old" }))),
  );
  await expect(plane.queryHistogram(request)).rejects.toThrow(
    "Invalid histogram",
  );
});

it("serves captured exact counts without accessing source tiles and honors abort", async () => {
  const plane = new BakedPlane(
    seal({
      session_json: "",
      signals: [],
      histograms: [{ panel_id: "p", bin_count: 1, response }],
    }),
  );
  expect(await plane.queryHistogram(request)).toEqual(response);
  await expect(
    plane.queryHistogram({ ...request, bin_count: 2 }),
  ).rejects.toThrow("not captured");
  const abort = new AbortController();
  const result = plane.queryHistogram(request, abort.signal);
  abort.abort();
  await expect(result).rejects.toThrow();
});
