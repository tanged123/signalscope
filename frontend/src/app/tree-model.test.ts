import { describe, expect, it } from "vitest";

import { buildTreeRows, virtualSlice } from "./tree-model";

const PATHS = [
  "rocket/velocity_body/x",
  "rocket/velocity_body/y",
  "rocket/attitude/roll",
  "gnc/pos_east",
];

describe("buildTreeRows", () => {
  it("groups by path segment with one group row per prefix", () => {
    const rows = buildTreeRows(PATHS, new Set(), "");
    expect(rows.map((row) => `${row.kind}:${row.path}`)).toEqual([
      "group:gnc",
      "leaf:gnc/pos_east",
      "group:rocket",
      "group:rocket/attitude",
      "leaf:rocket/attitude/roll",
      "group:rocket/velocity_body",
      "leaf:rocket/velocity_body/x",
      "leaf:rocket/velocity_body/y",
    ]);
    expect(rows[0]?.depth).toBe(0);
    expect(
      rows.find((row) => row.path === "rocket/velocity_body/x")?.depth,
    ).toBe(2);
  });

  it("hides everything under a collapsed group", () => {
    const rows = buildTreeRows(PATHS, new Set(["rocket"]), "");
    expect(rows.map((row) => row.path)).toEqual([
      "gnc",
      "gnc/pos_east",
      "rocket",
    ]);
    const rocket = rows.find((row) => row.path === "rocket");
    expect(rocket?.kind === "group" && rocket.expanded).toBe(false);
  });

  it("a filter returns flat matching leaves", () => {
    const rows = buildTreeRows(PATHS, new Set(["rocket"]), "body/y");
    expect(rows).toEqual([
      {
        kind: "leaf",
        path: "rocket/velocity_body/y",
        label: "rocket/velocity_body/y",
        depth: 0,
      },
    ]);
  });

  it("collapsed bundles show one row with a count; non-bundled paths keep the tree", () => {
    const paths = ["run_01/alt", "run_02/alt", "run_01/solo", "misc/other"];
    const rows = buildTreeRows(paths, new Set(), "", {
      sets: [{ key: "runs", label: "Runs", prefixes: ["run_01", "run_02"] }],
      expandedBundles: new Set<string>(),
    });
    const bundle = rows.find((row) => row.kind === "bundle");
    expect(bundle).toMatchObject({ path: "alt", runCount: 2, expanded: false });
    expect(
      rows.some((row) => row.kind === "leaf" && row.path === "run_01/solo"),
    ).toBe(true);
    expect(
      rows.some((row) => row.kind === "leaf" && row.path === "misc/other"),
    ).toBe(true);
  });

  it("expanded bundles list members labeled by source prefix", () => {
    const rows = buildTreeRows(
      ["run_01/alt", "run_02/alt", "run_01/solo", "misc/other"],
      new Set(),
      "",
      {
        sets: [{ key: "runs", label: "Runs", prefixes: ["run_01", "run_02"] }],
        expandedBundles: new Set(["runs//alt"]),
      },
    );
    const children = rows.filter(
      (row) =>
        row.kind === "leaf" && row.depth === 1 && row.path.endsWith("/alt"),
    );
    expect(children.map((row) => [row.path, row.label])).toEqual([
      ["run_01/alt", "run_01"],
      ["run_02/alt", "run_02"],
    ]);
  });

  it("search matches bundle paths and member labels", () => {
    const paths = ["run_01/alt", "run_02/alt", "run_01/solo", "misc/other"];
    const byBundle = buildTreeRows(paths, new Set(), "alt", {
      sets: [{ key: "runs", label: "Runs", prefixes: ["run_01", "run_02"] }],
      expandedBundles: new Set<string>(),
    });
    expect(byBundle.some((row) => row.kind === "bundle")).toBe(true);
    const byMember = buildTreeRows(paths, new Set(), "run_02", {
      sets: [{ key: "runs", label: "Runs", prefixes: ["run_01", "run_02"] }],
      expandedBundles: new Set(["runs//alt"]),
    });
    const children = byMember.filter(
      (row) => row.kind === "leaf" && row.depth === 1,
    );
    expect(children.map((row) => row.path)).toEqual(["run_02/alt"]);
  });

  it("keys bundles per set and adds headers only when several sets have bundles", () => {
    const sets = [
      { key: "sA", label: "Campaign A", prefixes: ["a1", "a2"] },
      { key: "sB", label: "Campaign B", prefixes: ["b1", "b2"] },
    ];
    const rows = buildTreeRows(
      ["a1/temp", "a2/temp", "b1/temp", "b2/temp"],
      new Set(),
      "",
      { sets, expandedBundles: new Set() },
    );
    const headers = rows.filter(
      (row) => row.kind === "group" && row.path.startsWith("set:"),
    );
    expect(headers.map((row) => row.label)).toEqual([
      "Campaign A",
      "Campaign B",
    ]);
    const bundles = rows.filter((row) => row.kind === "bundle");
    expect(bundles.map((row) => [row.setKey, row.runCount])).toEqual([
      ["sA", 2],
      ["sB", 2],
    ]);

    const single = buildTreeRows(["a1/temp", "a2/temp"], new Set(), "", {
      sets: sets.slice(0, 1),
      expandedBundles: new Set(),
    });
    expect(single.filter((row) => row.kind === "group")).toHaveLength(0);
    expect(single[0]).toMatchObject({ kind: "bundle", depth: 0 });
  });

  it("nested local paths produce collapsible group rows", () => {
    const sets = [{ key: "sA", label: "Campaign A", prefixes: ["a1", "a2"] }];
    const paths = [
      "a1/imu/accel/x",
      "a2/imu/accel/x",
      "a1/imu/accel/y",
      "a2/imu/accel/y",
    ];
    const rows = buildTreeRows(paths, new Set(), "", {
      sets,
      expandedBundles: new Set(),
    });
    expect(rows.map((row) => [row.kind, row.label, row.depth])).toEqual([
      ["group", "imu", 0],
      ["group", "accel", 1],
      ["bundle", "x", 2],
      ["bundle", "y", 2],
    ]);
    const collapsed = buildTreeRows(paths, new Set(["sA//imu"]), "", {
      sets,
      expandedBundles: new Set(),
    });
    expect(collapsed).toHaveLength(1);
  });

  it("bundle group keys never collide with source-prefix groups", () => {
    const rows = buildTreeRows(
      ["a1/imu/accel/x", "a2/imu/accel/x", "imu/standalone"],
      new Set(["sA//imu"]),
      "",
      {
        sets: [{ key: "sA", label: "Campaign A", prefixes: ["a1", "a2"] }],
        expandedBundles: new Set(),
      },
    );
    expect(
      rows.some((row) => row.kind === "leaf" && row.path === "imu/standalone"),
    ).toBe(true);
  });

  it("derived bundles render top-level, labeled by name, sorted among bundles", () => {
    const rows = buildTreeRows(
      [
        "run_01/command",
        "run_02/command",
        "run_01/derived/temp",
        "run_02/derived/temp",
        "run_01/response",
        "run_02/response",
      ],
      new Set(),
      "",
      {
        sets: [{ key: "runs", label: "Runs", prefixes: ["run_01", "run_02"] }],
        expandedBundles: new Set(),
      },
    );

    expect(rows.map((row) => [row.kind, row.label, row.depth])).toEqual([
      ["bundle", "command", 0],
      ["bundle", "response", 0],
      ["bundle", "temp", 0],
    ]);
    expect(rows.some((row) => row.path === "derived")).toBe(false);
  });

  it("unsourced derived leaves are ungrouped", () => {
    expect(buildTreeRows(["derived/score"], new Set(), "")).toEqual([
      { kind: "leaf", path: "derived/score", label: "score", depth: 0 },
    ]);
  });
});

describe("virtualSlice", () => {
  it("windows a 10k-row list to the viewport plus overscan", () => {
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
