import { describe, expect, it } from "vitest";
import type {
  HistogramRequest,
  HistogramResponse,
  HistogramSeries,
} from "../generated/protocol";
import {
  queryCapturedHistogram,
  validateHistogramCaptures,
  validateHistogramResponse,
} from "./histogram-data";

const request: HistogramRequest = {
  request_id: "h",
  signal_ids: ["1"],
  window: { t0: 0, t1: 2 },
  bin_count: 2,
};
function response(): HistogramResponse {
  return {
    request_id: "h",
    window: { t0: 0, t1: 2 },
    edges: [0, 1, 2],
    series: [
      {
        signal_id: "1",
        signal_path: "run/v",
        unit: "V",
        counts: ["9007199254740993", "2"],
        finite_count: "9007199254740995",
        excluded_count: "0",
      },
    ],
  };
}

describe("histogram boundary", () => {
  it("validates captured payloads before exposing them to presentation", () => {
    const capture = { panel_id: "p", bin_count: 2, response: response() };
    expect(validateHistogramCaptures([capture])).toEqual([capture]);
    for (const invalid of [
      {},
      [null],
      [capture, capture],
      [{ ...capture, response: {} }],
      [{ ...capture, bin_count: "2" }],
    ]) {
      expect(() => validateHistogramCaptures(invalid)).toThrow(
        "Invalid captured",
      );
    }
  });
  it("preserves exact counts beyond Number precision and checks their sum", () => {
    const value = response();
    expect(validateHistogramResponse(value, request).series[0]?.counts[0]).toBe(
      "9007199254740993",
    );
    (value.series[0] as HistogramSeries).finite_count = "9007199254740994";
    expect(() => validateHistogramResponse(value, request)).toThrow(
      "Invalid histogram",
    );
  });
  it("rejects malformed edges, IDs, units, counts, windows and request identity", () => {
    for (const mutate of [
      (r: HistogramResponse) => {
        r.edges = [0, 1, 1];
      },
      (r: HistogramResponse) => {
        r.edges[0] = NaN;
      },
      (r: HistogramResponse) => {
        (r.series[0] as HistogramSeries).counts[0] = "18446744073709551616";
      },
      (r: HistogramResponse) => {
        (r.series[0] as HistogramSeries).signal_id = "2";
      },
      (r: HistogramResponse) => {
        r.window.t0 = -1;
      },
      (r: HistogramResponse) => {
        r.request_id = "obsolete";
      },
    ]) {
      const value = response();
      mutate(value);
      expect(() => validateHistogramResponse(value, request)).toThrow(
        "Invalid histogram",
      );
    }
  });
  it("only serves the captured window, bins and complete shared-edge signal set", () => {
    const captures = [{ panel_id: "p", bin_count: 2, response: response() }];
    expect(
      queryCapturedHistogram(captures, { ...request, request_id: "next" })
        .request_id,
    ).toBe("next");
    for (const changed of [
      { ...request, bin_count: 3 },
      { ...request, window: { t0: 0, t1: 1 } },
      { ...request, signal_ids: [] },
    ])
      expect(() => queryCapturedHistogram(captures, changed)).toThrow(
        "not captured",
      );
  });
});
