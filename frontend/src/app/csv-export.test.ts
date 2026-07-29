import { describe, expect, it } from "vitest";

import type { SampleSeries } from "../generated/protocol";
import { buildCsv } from "./csv-export";

function series(path: string, time: number[], values: number[]): SampleSeries {
  return {
    signal_id: "1",
    signal_path: path,
    unit: null,
    time,
    values,
    stride: 1,
  };
}

describe("buildCsv", () => {
  it("uses the first series as the timebase and lerps the rest", () => {
    const base = series("a", [0, 1, 2], [10, 11, 12]);
    const other = series("b", [0, 2], [0, 4]);
    const csv = buildCsv([base, other], { t0: 0, t1: 2 });
    expect(csv.split("\n")[0]).toBe('time,"a","b"');
    expect(csv.split("\n")[2]).toBe("1,11,2");
  });

  it("clips rows to the visible window", () => {
    const base = series("a", [0, 1, 2, 3], [0, 1, 2, 3]);
    const csv = buildCsv([base], { t0: 1, t1: 2 });
    expect(csv.trim().split("\n")).toHaveLength(3);
  });

  it("escapes quotes in signal paths", () => {
    const base = series('weird"path', [0], [1]);
    expect(buildCsv([base], { t0: 0, t1: 0 }).split("\n")[0]).toBe(
      'time,"weird""path"',
    );
  });
});
