import { describe, expect, it } from "vitest";

import type { SignalSummary } from "../generated/protocol";
import { Catalog, DERIVED_SOURCE_KEY } from "./catalog";

function summary(
  sourceKey: string,
  path: string,
  localPath: string,
  unit: string | null = "m/s",
): SignalSummary {
  return {
    signal_id: `${sourceKey}-${localPath}`,
    source_id: sourceKey,
    source_key: sourceKey,
    local_path: localPath,
    path,
    unit,
    point_count: "2",
    t_min: 0,
    t_max: 1,
  };
}

describe("Catalog", () => {
  const catalog = Catalog.build([
    summary("run-02", "run_02/temp", "temp"),
    summary("run-01", "run_01/speed", "speed"),
    summary("run-01", "run_01/temp", "temp"),
    summary("run-02", "run_02/speed", "speed"),
    summary("derived", "derived/err", "err", null),
  ]);

  it("groups channels across sources", () => {
    expect(catalog.channels().map((channel) => channel.name)).toEqual([
      "err",
      "speed",
      "temp",
    ]);
    expect(
      catalog.channels().find((channel) => channel.name === "temp"),
    ).toMatchObject({ sourceKeys: ["run-02", "run-01"], unit: "m/s" });
  });

  it("uses a stable derived source key", () => {
    expect(catalog.refFromPath("derived/err")).toEqual({
      source_key: DERIVED_SOURCE_KEY,
      channel: "err",
    });
  });

  it("retains display source names", () => {
    expect(
      catalog.get({ source_key: "run-01", channel: "temp" }),
    ).toMatchObject({
      sourceName: "run_01",
    });
    expect(
      catalog.get({ source_key: DERIVED_SOURCE_KEY, channel: "err" }),
    ).toMatchObject({
      sourceName: "derived",
    });
  });

  it("round-trips paths and references", () => {
    for (const series of catalog.allSeries()) {
      const ref = catalog.refFromPath(series.path);
      expect(ref).toBeDefined();
      expect(catalog.get(ref as never)?.path).toBe(series.path);
    }
    const ref = catalog.refFromPath("run_01/temp");
    expect(ref).toEqual({ source_key: "run-01", channel: "temp" });
    expect(catalog.get(ref as never)?.path).toBe("run_01/temp");
  });

  it("retains null units", () => {
    expect(
      catalog.channels().find((channel) => channel.name === "err")?.unit,
    ).toBeNull();
  });
});
