import { describe, expect, it } from "vitest";

import type { SignalSummary } from "../generated/protocol";
import { Catalog } from "./catalog";
import {
  buildOutlineRows,
  filterCatalogSeries,
  virtualSlice,
  type OutlineOptions,
} from "./outline-model";

function summary(source: string, channel: string): SignalSummary {
  return {
    signal_id: `${source}-${channel}`,
    source_id: source,
    source_key: source,
    local_path: channel,
    path: `${source}/${channel}`,
    unit: null,
    point_count: "1",
    t_min: 0,
    t_max: 1,
    last_value: 42,
  };
}

const catalog = Catalog.build([
  summary("run_02", "temp"),
  summary("run_02", "speed"),
  summary("run_01", "speed"),
  summary("run_01", "temp"),
  summary("run_01", "solo"),
  summary("derived", "err"),
]);

function options(overrides: Partial<OutlineOptions> = {}): OutlineOptions {
  return { filter: "", expanded: new Set(), ...overrides };
}

describe("buildOutlineRows", () => {
  it("starts multi-source channels collapsed and flattens single-source channels", () => {
    const rows = buildOutlineRows(catalog, options());
    expect(
      rows.find((row) => row.kind === "group" && row.label === "temp"),
    ).toMatchObject({
      expanded: false,
      aggregate: "2 srcs",
      childKeys: [
        catalog.refKey({ source_key: "run_02", channel: "temp" }),
        catalog.refKey({ source_key: "run_01", channel: "temp" }),
      ],
    });
    expect(
      rows.some((row) => row.kind === "series" && row.path.endsWith("/temp")),
    ).toBe(false);
    expect(
      rows.find((row) => row.kind === "series" && row.path === "run_01/solo"),
    ).toMatchObject({ depth: 0, channel: "solo", source: "run_01" });
  });

  it("expands explicit channels and forces matching groups open", () => {
    const expanded = buildOutlineRows(
      catalog,
      options({ expanded: new Set(["group:channel:temp"]) }),
    );
    expect(
      expanded.filter(
        (row) => row.kind === "series" && row.path.endsWith("/temp"),
      ),
    ).toHaveLength(2);

    const filtered = buildOutlineRows(catalog, options({ filter: "temp" }));
    expect(filtered.filter((row) => row.kind === "series")).toHaveLength(2);
    expect(
      filtered.find((row) => row.kind === "group" && row.label === "temp"),
    ).toMatchObject({ expanded: true });
  });

  it("keeps selector filtering in the fixed outline", () => {
    expect(
      buildOutlineRows(catalog, options({ filter: "temp* @ run_01" })).map(
        (row) => (row.kind === "series" ? row.path : row.label),
      ),
    ).toEqual(["run_01/temp"]);
    expect(filterCatalogSeries(catalog, "missing")).toEqual([]);
  });

  it("builds ten thousand single-source channels within the outline budget", () => {
    const large = Catalog.build(
      Array.from({ length: 10_000 }, (_, index) =>
        summary("run_01", `channel_${String(index)}`),
      ),
    );
    expect(buildOutlineRows(large, options())).toHaveLength(10_000);
  });

  it("orders channel rows alphabetically", () => {
    const unsorted = Catalog.build([
      summary("run_01", "zulu"),
      summary("run_01", "alpha"),
    ]);
    expect(
      buildOutlineRows(unsorted, options()).map((row) =>
        row.kind === "series" ? row.channel : row.label,
      ),
    ).toEqual(["alpha", "zulu"]);
  });
});

describe("virtualSlice", () => {
  it("windows large row sets", () => {
    expect(virtualSlice(10_000, 2_200, 400, 22, 10)).toEqual({
      start: 90,
      end: 129,
      topPadding: 1_980,
      totalHeight: 220_000,
    });
  });

  it("caps stale scroll offsets at the end of the row set", () => {
    expect(virtualSlice(10, 10_000, 100, 20, 2)).toEqual({
      start: 10,
      end: 10,
      topPadding: 200,
      totalHeight: 200,
    });
  });
});
