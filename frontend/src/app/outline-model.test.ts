import { describe, expect, it } from "vitest";

import type { SignalSummary } from "../generated/protocol";
import { Catalog } from "./catalog";
import {
  buildOutlineRows,
  filterCatalogSeries,
  formatTableValue,
  virtualSlice,
  type OutlineOptions,
} from "./outline-model";

function summary(
  source: string,
  channel: string,
  points = 1,
  value: number | null = null,
  unit: string | null = "K",
): SignalSummary {
  return {
    signal_id: `${source}-${channel}`,
    source_id: source,
    source_key: source,
    local_path: channel,
    path: `${source}/${channel}`,
    unit,
    point_count: String(points),
    t_min: 0,
    t_max: points,
    last_value: value,
  };
}

const catalog = Catalog.build([
  summary("run_02", "temp", 20, 2),
  summary("run_02", "speed", 12, 3, "m/s"),
  summary("run_01", "speed", 10, null, "m/s"),
  summary("run_01", "temp", 30, 1),
  summary("run_01", "solo", 4, 4),
  summary("derived", "err", 5, 0.5, null),
]);

function options(overrides: Partial<OutlineOptions> = {}): OutlineOptions {
  return {
    filter: "",
    groupBy: "channel",
    sort: null,
    collapsed: new Set(),
    ...overrides,
  };
}

describe("buildOutlineRows", () => {
  it("groups channels and flattens single-child groups", () => {
    const rows = buildOutlineRows(catalog, options());
    const temp = rows.find(
      (row) => row.kind === "group" && row.label === "temp",
    );
    expect(temp).toMatchObject({
      kind: "group",
      aggregate: "2 srcs",
      pts: 50,
      unit: "K",
      unitConflict: false,
      names: ["temp"],
      aliases: ["run_02: temp", "run_01: temp"],
      childKeys: ["run_02\u0000temp", "run_01\u0000temp"],
    });
    expect(
      rows.filter((row) => row.kind === "series").map((row) => row.path),
    ).toEqual([
      "run_02/temp",
      "run_01/temp",
      "run_02/speed",
      "run_01/speed",
      "run_01/solo",
      "derived/err",
    ]);
    expect(
      rows.find((row) => row.kind === "series" && row.path === "run_01/solo"),
    ).toMatchObject({
      depth: 0,
      channel: "solo",
      source: "run_01",
    });
    expect(
      rows.find((row) => row.kind === "series" && row.path === "run_02/temp"),
    ).toMatchObject({
      depth: 1,
    });
  });

  it("honors collapsed groups while filters force expansion", () => {
    const collapsed = buildOutlineRows(
      catalog,
      options({ collapsed: new Set(["group:channel:temp"]) }),
    );
    expect(
      collapsed.find((row) => row.kind === "group" && row.label === "temp"),
    ).toMatchObject({
      expanded: false,
    });
    expect(
      collapsed.some(
        (row) => row.kind === "series" && row.path.endsWith("/temp"),
      ),
    ).toBe(false);

    const filtered = buildOutlineRows(
      catalog,
      options({ filter: "temp", collapsed: new Set(["group:channel:temp"]) }),
    );
    expect(
      filtered.find((row) => row.kind === "group" && row.label === "temp"),
    ).toMatchObject({
      expanded: true,
    });
  });

  it("mirrors grouping by source", () => {
    const rows = buildOutlineRows(catalog, options({ groupBy: "source" }));
    expect(
      rows.find((row) => row.kind === "group" && row.label === "run_01"),
    ).toMatchObject({
      aggregate: "3 chs",
      childKeys: ["run_01\u0000speed", "run_01\u0000temp", "run_01\u0000solo"],
    });
    expect(
      rows.find((row) => row.kind === "series" && row.path === "derived/err"),
    ).toMatchObject({
      depth: 0,
    });
  });

  it("supports flat rows and selector filtering", () => {
    const rows = buildOutlineRows(
      catalog,
      options({ groupBy: "none", filter: "temp* @ run_01" }),
    );
    expect(rows.every((row) => row.kind === "series")).toBe(true);
    expect(rows.map((row) => row.kind === "series" && row.path)).toEqual([
      "run_01/temp",
    ]);
    expect(filterCatalogSeries(catalog, "missing")).toEqual([]);
  });

  it("sorts flat rows and sorts children without changing grouped order", () => {
    const flat = buildOutlineRows(
      catalog,
      options({ groupBy: "none", sort: { column: "value", direction: "asc" } }),
    );
    expect(flat.map((row) => row.kind === "series" && row.value)).toEqual([
      0.5,
      1,
      2,
      3,
      4,
      null,
    ]);
    const grouped = buildOutlineRows(
      catalog,
      options({ sort: { column: "value", direction: "desc" } }),
    );
    const tempChildren = grouped
      .filter((row) => row.kind === "series" && row.path.endsWith("/temp"))
      .map((row) => row.kind === "series" && row.value);
    expect(tempChildren).toEqual([2, 1]);
    expect(
      grouped.findIndex((row) => row.kind === "group" && row.label === "temp"),
    ).toBeLessThan(
      grouped.findIndex((row) => row.kind === "group" && row.label === "speed"),
    );
    const byGroupLabel = buildOutlineRows(
      catalog,
      options({ sort: { column: "channel", direction: "desc" } }),
    );
    expect(
      byGroupLabel
        .filter((row) => row.kind === "group")
        .map((row) => row.label),
    ).toEqual(["temp", "speed"]);
  });

  it("builds ten thousand flat rows within the outline budget", () => {
    const large = Catalog.build(
      Array.from({ length: 10_000 }, (_, index) =>
        summary(
          `run_${String(index % 20).padStart(2, "0")}`,
          `channel_${String(index)}`,
        ),
      ),
    );
    const started = performance.now();
    const rows = buildOutlineRows(large, options({ groupBy: "none" }));
    expect(rows).toHaveLength(10_000);
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe("outline helpers", () => {
  it("windows rows and formats values", () => {
    expect(virtualSlice(10_000, 2_200, 400, 22, 10)).toEqual({
      start: 90,
      end: 129,
      topPadding: 1_980,
      totalHeight: 220_000,
    });
    expect(formatTableValue(1.23456)).toBe("1.2346");
    expect(formatTableValue(null)).toBe("—");
  });
});
