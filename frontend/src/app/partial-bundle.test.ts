// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { bundleCompletionEntries } from "../ui/app-shell";
import type { SetSummary, SignalSummary } from "../generated/protocol";

const signal = (
  sourceKey: string,
  path: string,
  localPath: string,
): SignalSummary => ({
  signal_id: path,
  source_id: sourceKey,
  source_key: sourceKey,
  local_path: localPath,
  path,
  unit: null,
  point_count: "2",
  t_min: 0,
  t_max: 1,
});

const set = (members: string[]): SetSummary => ({
  set_id: "1",
  set_key: "set-1",
  label: "Runs",
  generation: "1",
  member_count: members.length,
  members: members.map((source_key) => ({
    source_key,
    missing: [],
    scale: 1,
    offset: 0,
  })),
  time_domain: {
    unit: "seconds",
    origin: "relative",
    alignment_origin: 0,
  },
  local_paths: ["alt", "temp"],
  aligned: true,
});

describe("partial bundle membership", () => {
  it("offers only local paths with at least two members", () => {
    const signals = [
      signal("run-01", "run_01/temp", "temp"),
      signal("run-01", "run_01/alt", "alt"),
      signal("run-02", "run_02/temp", "temp"),
      signal("run-02", "run_02/alt", "alt"),
      signal("run-03", "run_03/temp", "temp"),
    ];
    expect(
      bundleCompletionEntries(signals, [set(["run-01", "run-02", "run-03"])]),
    ).toEqual([
      { localPath: "alt", runCount: 2 },
      { localPath: "temp", runCount: 3 },
    ]);
  });
});
