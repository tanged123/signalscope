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
      setPrefixes: ["run_01", "run_02"],
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
        setPrefixes: ["run_01", "run_02"],
        expandedBundles: new Set(["alt"]),
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
      setPrefixes: ["run_01", "run_02"],
      expandedBundles: new Set<string>(),
    });
    expect(byBundle.some((row) => row.kind === "bundle")).toBe(true);
    const byMember = buildTreeRows(paths, new Set(), "run_02", {
      setPrefixes: ["run_01", "run_02"],
      expandedBundles: new Set(["alt"]),
    });
    const children = byMember.filter(
      (row) => row.kind === "leaf" && row.depth === 1,
    );
    expect(children.map((row) => row.path)).toEqual(["run_02/alt"]);
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
