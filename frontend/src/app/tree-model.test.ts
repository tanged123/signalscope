import { describe, expect, it } from "vitest";

import type { SignalSummary } from "../generated/protocol";
import { Catalog } from "./catalog";
import {
  buildTreeRows,
  virtualSlice,
  type TreeChannel,
  type TreeLeaf,
} from "./tree-model";

function signal(sourceKey: string, channel: string): SignalSummary {
  return {
    signal_id: `${sourceKey}-${channel}`,
    source_id: sourceKey,
    source_key: sourceKey,
    local_path: channel,
    path: `${sourceKey}/${channel}`,
    unit: null,
    point_count: "1",
    t_min: 0,
    t_max: 0,
  };
}

describe("buildTreeRows", () => {
  const catalog = Catalog.build([
    signal("run-01", "temp"),
    signal("run-02", "temp"),
    signal("run-01", "solo"),
    signal("derived", "err"),
  ]);

  it("groups shared channels and expands their source rows", () => {
    const rows = buildTreeRows(catalog, new Set(["channel:temp"]), "");
    expect(rows).toEqual([
      { kind: "leaf", path: "derived/err", label: "derived/err", depth: 0 },
      { kind: "leaf", path: "run-01/solo", label: "run-01/solo", depth: 0 },
      {
        kind: "channel",
        path: "channel:temp",
        label: "temp — 2 srcs",
        depth: 0,
        sourceKeys: ["run-01", "run-02"],
        expanded: false,
        members: ["run-01/temp", "run-02/temp"],
      },
    ]);
    const expanded = buildTreeRows(catalog, new Set(), "");
    const leaf: TreeLeaf | undefined = expanded.find(
      (row): row is TreeLeaf => row.kind === "leaf",
    );
    const channel: TreeChannel | undefined = expanded.find(
      (row): row is TreeChannel => row.kind === "channel",
    );
    expect(leaf?.kind).toBe("leaf");
    expect(channel?.kind).toBe("channel");
    expect(expanded.map((row) => row.path)).toContain("run-01/temp");
    expect(expanded.find((row) => row.kind === "channel")?.label).toBe(
      "temp — 2 srcs",
    );
  });

  it("filters by channel or member path", () => {
    const rows = buildTreeRows(catalog, new Set(), "run-02");
    expect(rows.map((row) => row.path)).toEqual([
      "channel:temp",
      "run-02/temp",
    ]);
  });

  it("keeps derived channels at the top level", () => {
    expect(buildTreeRows(catalog, new Set(), "err")[0]).toMatchObject({
      kind: "leaf",
      path: "derived/err",
    });
  });
});

describe("virtualSlice", () => {
  it("windows a large list to the viewport plus overscan", () => {
    const slice = virtualSlice(10_000, 2_200, 400, 22, 10);
    expect(slice.start).toBe(90);
    expect(slice.end).toBe(129);
    expect(slice.topPadding).toBe(90 * 22);
    expect(slice.totalHeight).toBe(220_000);
  });

  it("clamps at both ends", () => {
    expect(virtualSlice(5, 0, 400, 22).start).toBe(0);
    expect(virtualSlice(5, 0, 400, 22).end).toBe(5);
  });
});
