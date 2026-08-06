import { describe, expect, it } from "vitest";
import type { SampleRequest, SampleResponse } from "../generated/protocol";
import { SampleWindowCache } from "./sample-window-cache";
import { fetchXySamples } from "./xy-samples";

function planeStub(): {
  calls: SampleRequest[];
  plane: { querySamples: (request: SampleRequest) => Promise<SampleResponse> };
} {
  const calls: SampleRequest[] = [];
  return {
    calls,
    plane: {
      querySamples: (request: SampleRequest) => {
        calls.push(request);
        return Promise.resolve({
          request_id: request.request_id,
          series: [
            {
              signal_id: "sig-1",
              signal_path: "run_0001/response",
              unit: null,
              time: [request.window.t0, request.window.t1],
              values: [1, 2],
              stride: 1,
            },
          ],
        });
      },
    },
  };
}

describe("fetchXySamples", () => {
  const contextWindow = { t0: 0, t1: 1000 };

  it("fetches the context window once across pans", async () => {
    const { calls, plane } = planeStub();
    const contextCache = new SampleWindowCache();
    const base = {
      plane,
      panelId: "panel",
      ids: ["sig-1"],
      cap: 124,
      contextWindow,
      contextCache,
    };
    await fetchXySamples({ ...base, window: { t0: 0, t1: 100 } });
    await fetchXySamples({ ...base, window: { t0: 100, t1: 200 } });
    expect(calls).toHaveLength(3);
    const contextCalls = calls.filter(
      (request) =>
        request.window.t0 === contextWindow.t0 &&
        request.window.t1 === contextWindow.t1,
    );
    expect(contextCalls).toHaveLength(1);
  });

  it("re-fetches context when the data extent or cap changes", async () => {
    const { calls, plane } = planeStub();
    const contextCache = new SampleWindowCache();
    const base = {
      plane,
      panelId: "panel",
      ids: ["sig-1"],
      contextCache,
      window: { t0: 0, t1: 100 },
    };
    await fetchXySamples({ ...base, cap: 124, contextWindow });
    await fetchXySamples({
      ...base,
      cap: 124,
      contextWindow: { t0: 0, t1: 2000 },
    });
    await fetchXySamples({ ...base, cap: 200, contextWindow });
    expect(calls).toHaveLength(6);
  });
});
