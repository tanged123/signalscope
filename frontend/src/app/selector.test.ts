import { describe, expect, it } from "vitest";

import { Catalog } from "./catalog";
import {
  compileGlob,
  evaluateSelector,
  parseSelector,
  seriesMatches,
  type Selector,
  type SelectorAttr,
} from "./selector";

function catalogFixture(): Catalog {
  const entries: readonly [string, string, string | null][] = [
    ["run_01", "temp", "K"],
    ["run_01", "temp_sp", "K"],
    ["run_01", "pressure", "Pa"],
    ["run_02", "temp", "K"],
    ["run_02", "temp_sp", "K"],
    ["run_02", "pressure", "Pa"],
    ["bench", "temp", "K"],
    ["bench", "temp_sp", "K"],
    ["bench", "pressure", "Pa"],
    ["derived", "err", null],
  ];
  const summaries = entries.map(([sourceKey, channel, unit], index) => ({
    signal_id: String(index),
    source_id: sourceKey,
    source_key: sourceKey,
    local_path: channel,
    path: sourceKey === "derived" ? "derived/err" : `${sourceKey}/${channel}`,
    unit,
    point_count: "1",
    t_min: 0,
    t_max: 1,
  }));
  return Catalog.build(summaries);
}

describe("evaluateSelector", () => {
  const catalog = catalogFixture();

  it("matches channel globs across sources", () => {
    expect(evaluateSelector(catalog, "temp*")?.signalCount).toBe(6);
  });

  it("filters by display source name", () => {
    expect(
      evaluateSelector(catalog, "temp* @ run_0[1-2]")?.series.map(
        (entry) => entry.sourceName,
      ),
    ).toEqual(["run_01", "run_01", "run_02", "run_02"]);
  });

  it("filters by unit and kind", () => {
    expect(evaluateSelector(catalog, "* unit:K")?.signalCount).toBe(6);
    expect(
      evaluateSelector(catalog, "* kind:derived")?.series.map(
        (entry) => entry.path,
      ),
    ).toEqual(["derived/err"]);
  });

  it("reports signal and source counts", () => {
    expect(evaluateSelector(catalog, "temp* @ run_*")).toMatchObject({
      signalCount: 4,
      sourceCount: 2,
    });
  });

  it("returns null for parse failures and keeps bare literals exact", () => {
    expect(evaluateSelector(catalog, "run_[")).toBeNull();
    expect(
      evaluateSelector(catalog, "temp")?.series.map((entry) => entry.channel),
    ).toEqual(["temp", "temp", "temp"]);
  });

  it("matches an individual series with the parsed selector contract", () => {
    const parsed = parseSelector("temp unit:K");
    if (!parsed.ok) throw new Error(parsed.error);
    const selector: Selector = parsed.selector;
    const unit: SelectorAttr = { key: "unit", value: "K" };
    const series = catalog.allSeries()[0];
    if (series === undefined) throw new Error("catalog fixture is empty");
    expect(selector.attrs).toContainEqual(unit);
    expect(seriesMatches(selector, series)).toBe(true);
  });
});

describe("compileGlob", () => {
  const accepts: [string, string[]][] = [
    ["temp", ["temp"]],
    ["derived/temp*", ["derived/temp", "derived/temp_sp"]],
    ["temp?", ["temp1", "tempA"]],
    ["command|response", ["command", "response"]],
    ["run_0[1-3]", ["run_01", "run_02", "run_03"]],
    ["imu/a?", ["imu/ax", "imu/az"]],
  ];
  const rejects: [string, string[]][] = [
    ["temp", ["temperature", "TEMP", "a/temp"]],
    ["derived/temp*", ["temp", "derived2/temp"]],
    ["temp?", ["temp", "temp12"]],
    ["command|response", ["commandx", "respond"]],
    ["run_0[1-3]", ["run_04", "run_0"]],
  ];

  it.each(accepts)("%s accepts %s", (glob, values) => {
    const re = compileGlob(glob);
    for (const value of values) expect(re?.test(value)).toBe(true);
  });

  it.each(rejects)("%s rejects %s", (glob, values) => {
    const re = compileGlob(glob);
    for (const value of values) expect(re?.test(value)).toBe(false);
  });

  it("regex metacharacters in literals are inert", () => {
    expect(compileGlob("a.b")?.test("a.b")).toBe(true);
    expect(compileGlob("a.b")?.test("axb")).toBe(false);
    expect(compileGlob("a+b")?.test("a+b")).toBe(true);
  });

  it("unterminated range is malformed", () => {
    expect(compileGlob("run_[1")).toBeNull();
  });
});

describe("parseSelector", () => {
  it("parses a channel-only selector", () => {
    const parsed = parseSelector("derived/temp*");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.selector.channelText).toBe("derived/temp*");
    expect(parsed.selector.source).toBeNull();
    expect(parsed.selector.attrs).toEqual([]);
  });

  it("parses detached and attached source terms", () => {
    for (const input of ["derived/temp* @ run_*", "derived/temp* @run_*"]) {
      const parsed = parseSelector(input);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.selector.sourceText).toBe("run_*");
      expect(parsed.selector.source?.test("run_07")).toBe(true);
    }
  });

  it("parses attrs and rejects unknown keys", () => {
    const parsed = parseSelector("temp* @ run_* unit:K kind:derived");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.selector.attrs).toEqual([
        { key: "unit", value: "K" },
        { key: "kind", value: "derived" },
      ]);
    }
    expect(parseSelector("temp foo:bar").ok).toBe(false);
  });

  it("rejects empty, incomplete, malformed, and duplicate source terms", () => {
    expect(parseSelector("").ok).toBe(false);
    expect(parseSelector("@ run_*").ok).toBe(false);
    expect(parseSelector("run_[1").ok).toBe(false);
    expect(parseSelector("a @ b @ c").ok).toBe(false);
  });
});
