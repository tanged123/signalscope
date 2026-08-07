import { describe, expect, it } from "vitest";
import {
  arrivalModeFor,
  bundleCompletionEntries,
  exportSourceOptions,
  statusAggregate,
} from "./app-shell";
import type { SignalSummary } from "../generated/protocol";

function signal(
  path: string,
  sourceKey: string,
  localPath: string,
): SignalSummary {
  return {
    signal_id: path,
    source_id: sourceKey,
    source_key: sourceKey,
    local_path: localPath,
    path,
    unit: null,
    point_count: "2",
    t_min: 0,
    t_max: 1,
    last_value: null,
  };
}

describe("time-only shell helpers", () => {
  it("assigns small arrivals to focus and larger arrivals to ghosts", () => {
    expect(arrivalModeFor(0)).toBe("none");
    expect(arrivalModeFor(4)).toBe("focus");
    expect(arrivalModeFor(5)).toBe("ghost");
  });

  it("formats aggregate status and source export labels", () => {
    expect(statusAggregate(2, 5, 10)).toBe("2 sources · 5 signals · 10 pts");
    expect(exportSourceOptions([signal("run/a", "run", "a")])).toEqual([
      { key: "run", label: "run" },
    ]);
  });

  it("finds channels shared by multiple sources", () => {
    expect(
      bundleCompletionEntries([
        signal("run1/temp", "run1", "temp"),
        signal("run2/temp", "run2", "temp"),
        signal("run1/other", "run1", "other"),
      ]),
    ).toEqual([{ localPath: "temp", runCount: 2 }]);
  });
});
