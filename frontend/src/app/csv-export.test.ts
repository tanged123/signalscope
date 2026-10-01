import { describe, expect, it, test } from "vitest";

import type { HistogramResponse, SampleSeries } from "../generated/protocol";
import { buildCsv, buildHistogramCsv, csvMaxPoints } from "./csv-export";

function series(
  path: string,
  time: number[],
  values: number[],
  stride = 1,
): SampleSeries {
  return {
    signal_id: "1",
    signal_path: path,
    unit: null,
    time,
    values,
    stride,
  };
}

describe("buildCsv", () => {
  it("uses the first series as the timebase and lerps the rest", () => {
    const base = series("a", [0, 1, 2], [10, 11, 12]);
    const other = series("b", [0, 2], [0, 4]);
    const csv = buildCsv([base, other], { t0: 0, t1: 2 });
    expect(csv.text.split("\n")[0]).toBe('time,"a","b"');
    expect(csv.text.split("\n")[2]).toBe("1,11,2");
    expect(csv.rows).toBe(3);
    expect(csv.stride).toBe(1);
  });

  it("clips rows to the visible window", () => {
    const base = series("a", [0, 1, 2, 3], [0, 1, 2, 3]);
    const csv = buildCsv([base], { t0: 1, t1: 2 });
    expect(csv.text.trim().split("\n")).toHaveLength(3);
    expect(csv.rows).toBe(2);
  });

  it("escapes quotes in signal paths", () => {
    const base = series('weird"path', [0], [1]);
    expect(buildCsv([base], { t0: 0, t1: 0 }).text.split("\n")[0]).toBe(
      'time,"weird""path"',
    );
  });

  it("keeps stride awareness out of the file and reports it separately", () => {
    const base = series("a", [0, 2], [10, 12], 2);
    const other = series('b"quoted', [0, 3], [20, 23], 3);
    const csv = buildCsv([base, other], { t0: 0, t1: 3 });
    expect(csv.text.split("\n")[0]).toBe('time,"a","b""quoted"');
    expect(csv.stride).toBe(3);
  });

  it("maps fidelity to the shared export ceilings", () => {
    expect([
      csvMaxPoints("preview"),
      csvMaxPoints("standard"),
      csvMaxPoints("high"),
      csvMaxPoints("full"),
    ]).toEqual([512, 2_048, 16_384, 4_294_967_295]);
  });
});

test("buildHistogramCsv preserves bin edges, units, and exact counts", () => {
  const response: HistogramResponse = {
    request_id: "hist-1",
    window: { t0: 0, t1: 5 },
    edges: [-1, 0, 2],
    series: [
      {
        signal_id: "1",
        signal_path: "run/value",
        unit: "V",
        counts: ["9007199254740993", "2"],
        finite_count: "9007199254740995",
        excluded_count: "0",
      },
    ],
  };
  const csv = buildHistogramCsv(response);
  expect(csv.text).toBe(
    '"bin_start [V]","bin_end [V]",source_window_t0,source_window_t1,"run/value count"\n-1,0,0,5,9007199254740993\n0,2,0,5,2\n',
  );
  expect(csv.rows).toBe(2);
  expect(csv.stride).toBe(1);
});
