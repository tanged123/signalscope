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

  it("collapses set members into one local-path row", () => {
    const rows = buildTreeRows(
      ["run_a/imu/ax", "run_b/imu/ax"],
      new Set(),
      "",
      { setPrefixes: ["run_a", "run_b"] },
    );
    const leaf = rows.find((row) => row.kind === "leaf");
    expect(leaf?.label).toBe("imu/ax");
    expect(leaf?.runCount).toBe(2);
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
