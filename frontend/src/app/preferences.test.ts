// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import {
  applyPreferences,
  clampPlotFontSize,
  clampUiFontSize,
  defaultPreferences,
  fontStack,
  parsePreferences,
  snapshotPreferences,
  PLOT_FONT_SIZE,
  UI_FONT_SIZE,
} from "./preferences";

describe("preferences", () => {
  it("defaults match the spec", () => {
    const prefs = defaultPreferences();
    expect(prefs.schema_version).toBe(6);
    expect(prefs.theme).toBe("dark");
    expect(prefs.ui_font_family).toBe("inter");
    expect(prefs.plot_font_family).toBe("jetbrains");
    expect(prefs.ui_font_size).toBe(13);
    expect(prefs.plot_font_size).toBe(9);
    expect(prefs.plot_line_width_scale).toBe(1);
    expect(prefs.cache_max_bytes).toBe("21474836480");
  });

  it("clamps sizes to their ranges and steps", () => {
    expect(clampUiFontSize(0)).toBe(UI_FONT_SIZE.min);
    expect(clampUiFontSize(99)).toBe(UI_FONT_SIZE.max);
    expect(clampUiFontSize(12.4)).toBe(12);
    expect(clampPlotFontSize(0)).toBe(PLOT_FONT_SIZE.min);
    expect(clampPlotFontSize(99)).toBe(PLOT_FONT_SIZE.max);
    expect(clampPlotFontSize(9.26)).toBe(9.5);
  });

  it("parses a round-tripped document", () => {
    const prefs = { ...defaultPreferences(), plot_font_size: 11.5 };
    expect(parsePreferences(JSON.stringify(prefs))).toEqual(prefs);
  });

  it("captures appearance without local paths or resource settings", () => {
    const appearance = {
      ui_font_family: "arimo" as const,
      plot_font_family: "dejavu" as const,
      ui_font_size: 15,
      plot_font_size: 12.5,
      plot_line_width_scale: 1.75,
    };
    const json = snapshotPreferences({
      ...defaultPreferences(),
      ...appearance,
      cache_root: "/private/cache",
      recipe_directory: "/private/recipes",
      ingest_working_bytes: "1234",
    });
    expect(JSON.parse(json)).toEqual({ schema_version: 6, ...appearance });
    expect(parsePreferences(json)).toEqual({
      ...defaultPreferences(),
      ...appearance,
    });
  });

  it("migrates schema 1 with default budgets", () => {
    const parsed = parsePreferences(
      JSON.stringify({
        schema_version: 1,
        ui_font_family: "inter",
        plot_font_family: "jetbrains",
        ui_font_size: 13,
        plot_font_size: 9,
      }),
    );

    expect(parsed).toEqual(defaultPreferences());
  });

  it("rejects malformed json and future versions", () => {
    expect(parsePreferences("{nope")).toBeNull();
    expect(parsePreferences("null")).toBeNull();
    expect(
      parsePreferences(
        JSON.stringify({ ...defaultPreferences(), schema_version: 99 }),
      ),
    ).toBeNull();
  });

  it("repairs unknown families and out-of-range sizes", () => {
    const parsed = parsePreferences(
      JSON.stringify({
        ...defaultPreferences(),
        ui_font_family: "comic-sans",
        ui_font_size: 400,
      }),
    );
    expect(parsed?.ui_font_family).toBe("inter");
    expect(parsed?.ui_font_size).toBe(UI_FONT_SIZE.max);
  });

  it("resets legacy plot line widths and repairs current values", () => {
    const migrated = parsePreferences(
      JSON.stringify({
        ...defaultPreferences(),
        schema_version: 5,
        plot_line_width_scale: 0.5,
      }),
    );
    const repaired = parsePreferences(
      JSON.stringify({
        ...defaultPreferences(),
        schema_version: 6,
        plot_line_width_scale: 0.63,
      }),
    );
    const clamped = parsePreferences(
      JSON.stringify({
        ...defaultPreferences(),
        schema_version: 6,
        plot_line_width_scale: 99,
      }),
    );

    expect(migrated?.plot_line_width_scale).toBe(1);
    expect(repaired?.plot_line_width_scale).toBe(0.75);
    expect(clamped?.plot_line_width_scale).toBe(2);
  });

  it("applies css variables and the root font size", () => {
    const set = new Map<string, string>();
    const target = {
      style: {
        setProperty: (name: string, value: string) => set.set(name, value),
        fontSize: "",
      },
      dataset: {} as DOMStringMap,
    };
    applyPreferences(
      { ...defaultPreferences(), plot_font_family: "dejavu" },
      target,
    );
    expect(set.get("--font-ui")).toBe(fontStack("inter"));
    expect(set.get("--font-plot")).toBe(fontStack("dejavu"));
    expect(set.get("--plot-font-size")).toBe("9");
    expect(set.get("--plot-line-width-scale")).toBe("1");
    expect(target.style.fontSize).toBe("13px");
  });

  it("defaults the theme to dark", () => {
    expect(defaultPreferences().theme).toBe("dark");
  });

  it("applies the stored theme to the document root", () => {
    const root = document.createElement("html");
    applyPreferences({ ...defaultPreferences(), theme: "light" }, root);
    expect(root.dataset.theme).toBe("light");
  });
});
