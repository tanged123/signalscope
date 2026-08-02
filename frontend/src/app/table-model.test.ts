import { describe, expect, it } from "vitest";

import type { SignalSummary } from "../generated/protocol";
import { Catalog } from "./catalog";
import { virtualSlice } from "./tree-model";
import { buildTableRows } from "./table-model";

function summary(
  source: string,
  channel: string,
  points: number,
  value: number | null,
  unit = "K",
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
  summary("run_01", "speed", 10, null, "m/s"),
  summary("run_01", "temp", 30, 1),
  summary("run_03", "speed", 40, 4, "m/s"),
]);

describe("buildTableRows", () => {
  it("builds series rows from summaries and selector filters", () => {
    expect(
      buildTableRows(catalog, "temp* @ run_0[1-2]", null, "series").map(
        (row) => [row.channel, row.source, row.pts, row.value],
      ),
    ).toEqual([
      ["temp", "run_02", 20, 2],
      ["temp", "run_01", 30, 1],
    ]);
    expect(buildTableRows(catalog, "speed", null, "series")).toHaveLength(2);
    expect(buildTableRows(catalog, "missing", null, "series")).toEqual([]);
  });

  it("groups filtered series into channel rows", () => {
    const rows = buildTableRows(catalog, "temp", null, "channels");

    expect(rows).toEqual([
      {
        key: "channel:temp",
        refs: [
          { source_key: "run_02", channel: "temp" },
          { source_key: "run_01", channel: "temp" },
        ],
        channel: "temp",
        source: "2 srcs",
        unit: "K",
        pts: 50,
        value: null,
      },
    ]);
  });

  it("sorts every column in both directions with nulls last", () => {
    expect(
      buildTableRows(
        catalog,
        "",
        { column: "channel", direction: "asc" },
        "series",
      ).map((row) => row.channel),
    ).toEqual(["speed", "speed", "temp", "temp"]);
    expect(
      buildTableRows(
        catalog,
        "",
        { column: "source", direction: "desc" },
        "series",
      ).map((row) => row.source),
    ).toEqual(["run_03", "run_02", "run_01", "run_01"]);
    expect(
      buildTableRows(
        catalog,
        "",
        { column: "unit", direction: "asc" },
        "series",
      ).map((row) => row.unit),
    ).toEqual(["K", "K", "m/s", "m/s"]);
    expect(
      buildTableRows(
        catalog,
        "",
        { column: "pts", direction: "desc" },
        "series",
      ).map((row) => row.pts),
    ).toEqual([40, 30, 20, 10]);
    expect(
      buildTableRows(
        catalog,
        "",
        { column: "value", direction: "asc" },
        "series",
      ).map((row) => row.value),
    ).toEqual([1, 2, 4, null]);
    expect(
      buildTableRows(catalog, "", null, "series").map((row) => row.key),
    ).toEqual([
      "run_02\u0000temp",
      "run_01\u0000speed",
      "run_01\u0000temp",
      "run_03\u0000speed",
    ]);
  });

  it("builds and windows ten thousand rows within the table budget", () => {
    const large = Catalog.build(
      Array.from({ length: 10_000 }, (_, index) =>
        summary(`run_${String(index).padStart(5, "0")}`, "temp", 1, index),
      ),
    );
    const started = performance.now();
    const rows = buildTableRows(large, "temp", null, "series");
    const slice = virtualSlice(rows.length, 5_000, 400, 22);

    expect(performance.now() - started).toBeLessThan(250);
    expect(slice.end - slice.start).toBeLessThan(60);
  });
});
