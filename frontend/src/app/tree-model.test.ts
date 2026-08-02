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
    last_value: null,
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
        label: "temp",
        depth: 0,
        sourceKeys: ["run-01", "run-02"],
        sourceCount: 2,
        expanded: false,
        members: ["run-01/temp", "run-02/temp"],
        names: ["temp"],
        aliases: ["run-01: temp", "run-02: temp"],
        unitConflict: false,
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
    expect(expanded.find((row) => row.kind === "channel")?.label).toBe("temp");
  });

  it("exposes merged alias names and a separate source count", () => {
    const merged = Catalog.build(
      [signal("run-01", "temp"), signal("run-02", "temperature")],
      [
        {
          canonical: "temp",
          aliases: [
            { source_key: "run-01", name: "temp" },
            { source_key: "run-02", name: "temperature" },
          ],
        },
      ],
    );
    expect(buildTreeRows(merged, new Set(), "")[0]).toMatchObject({
      kind: "channel",
      label: "temp",
      sourceCount: 2,
      aliases: ["run-01: temp", "run-02: temperature"],
    });
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

  it("uses selectors first and substring matching as the fallback", () => {
    expect(
      buildTreeRows(catalog, new Set(), "temp* @ run-01").map(
        (row) => row.path,
      ),
    ).toEqual(["channel:temp", "run-01/temp"]);
    expect(
      buildTreeRows(catalog, new Set(), "temp").map((row) => row.path),
    ).toEqual(["channel:temp", "run-01/temp", "run-02/temp"]);
    expect(buildTreeRows(catalog, new Set(), "xyz[")).toEqual([]);
    expect(
      buildTreeRows(catalog, new Set(), "emp").map((row) => row.path),
    ).toEqual(["channel:temp", "run-01/temp", "run-02/temp"]);
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
