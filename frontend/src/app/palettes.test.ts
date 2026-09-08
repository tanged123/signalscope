// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import type { Preferences } from "../generated/preferences";
import {
  COLOR_PALETTES,
  DEFAULT_CONTOUR,
  CONTOUR_PALETTES,
  compileContour,
  contourStops,
  discreteColors,
  sampleContour,
  validColors,
  validStops,
} from "./palettes";
import {
  applyPreferences,
  defaultPreferences,
  parsePreferences,
  snapshotPreferences,
} from "./preferences";
import {
  hueIndex,
  invalidatePalette,
  resolvePalette,
} from "../render/plot-theme";

afterEach(() => {
  document.documentElement.removeAttribute("style");
  invalidatePalette();
});

test("presets keep the published color order and full continuous tables", () => {
  expect(COLOR_PALETTES.tol_contrast.colors).toEqual([
    "#004488",
    "#ddaa33",
    "#bb5566",
  ]);
  for (const [id, preset] of Object.entries(CONTOUR_PALETTES)) {
    expect(preset.stops).toHaveLength(id === "gray" ? 2 : 256);
    expect(preset.stops[0]?.position).toBe(0);
    expect(preset.stops.at(-1)?.position).toBe(1);
  }
  expect(CONTOUR_PALETTES.viridis.stops[0]?.color).toBe("#440154");
  expect(CONTOUR_PALETTES.viridis.stops.at(-1)?.color).toBe("#fde725");
});

test("sampling preserves irregular stops, clamps and reverses without changing saved colors", () => {
  const prefs = defaultPreferences();
  prefs.contour_palette = "custom";
  prefs.custom_contour_palette = [
    { position: 0, color: "#000000" },
    { position: 0.5, color: "#ff0000" },
    { position: 0.500001, color: "#00ff00" },
    { position: 1, color: "#ffffff" },
  ];
  const original = JSON.stringify(prefs.custom_contour_palette);
  const contour = compileContour(contourStops(prefs));
  expect(sampleContour(contour, -1)).toEqual([0, 0, 0, 1]);
  expect(sampleContour(contour, 0.25)).toEqual([0.5, 0, 0, 1]);
  expect(sampleContour(contour, 0.500001)).toEqual([0, 1, 0, 1]);
  expect(sampleContour(contour, 2)).toEqual([1, 1, 1, 1]);
  prefs.contour_reversed = true;
  const reversed = compileContour(contourStops(prefs));
  expect(sampleContour(reversed, 0)).toEqual([1, 1, 1, 1]);
  expect(sampleContour(reversed, 0.75)).toEqual([0.5, 0, 0, 1]);
  expect(JSON.stringify(prefs.custom_contour_palette)).toBe(original);
});

test("custom validation rejects malformed colors and ambiguous stops", () => {
  expect(validColors(["#ABCDEF"])).toBe(true);
  for (const colors of [[], ["red"], ["#abc"], ["#12345678"], [null]]) {
    expect(validColors(colors)).toBe(false);
  }
  const stops = [
    { position: 0, color: "#000000" },
    { position: 1, color: "#ffffff" },
  ];
  expect(validStops(stops)).toBe(true);
  for (const invalid of [
    [stops[0]],
    [{ position: 0.1, color: "#000000" }, stops[1]],
    [stops[0], { position: 0, color: "#ffffff" }, stops[1]],
    [stops[0], { position: NaN, color: "#ffffff" }, stops[1]],
    [stops[1], stops[0]],
    [stops[0], { position: 1, color: "red" }],
  ])
    expect(validStops(invalid)).toBe(false);
});

test("large custom palettes and full contour tables survive preferences and reach the renderer", () => {
  const colors = Array.from(
    { length: 300 },
    (_, index) => "#" + index.toString(16).padStart(6, "0"),
  );
  const prefs = {
    ...defaultPreferences(),
    color_palette: "custom" as const,
    custom_color_palette: colors,
    contour_palette: "custom" as const,
    custom_contour_palette: CONTOUR_PALETTES.viridis.stops,
  };
  expect(validColors(colors)).toBe(true);
  expect(validStops(prefs.custom_contour_palette)).toBe(true);
  expect(parsePreferences(snapshotPreferences(prefs))).toEqual(prefs);
  applyPreferences(prefs, document.documentElement);
  invalidatePalette();
  expect(resolvePalette().series).toEqual(colors);
  expect(hueIndex(300, resolvePalette().series.length)).toBe(299);
  expect(document.documentElement.style.getPropertyValue("--series-300")).toBe(
    colors[299],
  );
  applyPreferences(
    { ...prefs, color_palette: "brewer_paired" },
    document.documentElement,
  );
  invalidatePalette();
  expect(resolvePalette().series).toEqual(COLOR_PALETTES.brewer_paired.colors);
  expect(resolvePalette().series).toHaveLength(12);
});

test("migration keeps v6 stroke sizes, repairs fields independently and exports custom appearance", () => {
  expect(
    parsePreferences(
      JSON.stringify({ schema_version: 6, plot_line_width_scale: 1.75 }),
    ),
  ).toEqual({ ...defaultPreferences(), plot_line_width_scale: 1.75 });
  const prefs = {
    ...defaultPreferences(),
    color_palette: "custom" as const,
    custom_color_palette: ["#ABCDEF", "#012345"],
    contour_palette: "vik" as const,
    contour_reversed: true,
  };
  const parsed = parsePreferences(JSON.stringify(prefs)) as Preferences;
  expect(parsed.custom_color_palette).toEqual(["#abcdef", "#012345"]);
  expect(parsePreferences(snapshotPreferences(parsed))).toEqual(parsed);
  const repaired = parsePreferences(
    JSON.stringify({
      ...prefs,
      custom_color_palette: ["red"],
      custom_contour_palette: [],
      contour_palette: "unknown",
    }),
  ) as Preferences;
  expect(repaired.color_palette).toBe("custom");
  expect(repaired.custom_color_palette).toEqual(
    defaultPreferences().custom_color_palette,
  );
  expect(repaired.custom_contour_palette).toEqual(
    defaultPreferences().custom_contour_palette,
  );
  expect(repaired.contour_palette).toBe("viridis");
  expect(repaired.contour_reversed).toBe(true);
});

test("selected palettes reach CSS, render sampling and variable-length slot wrapping", () => {
  const prefs = {
    ...defaultPreferences(),
    color_palette: "tol_contrast" as const,
    contour_palette: "gray" as const,
    contour_reversed: true,
  };
  applyPreferences(prefs, document.documentElement);
  invalidatePalette();
  const rendered = resolvePalette();
  expect(rendered.series).toEqual(discreteColors(prefs));
  expect(hueIndex(9, rendered.series.length)).toBe(2);
  expect(sampleContour(rendered.contour ?? DEFAULT_CONTOUR, 0)).toEqual([
    1, 1, 1, 1,
  ]);
  expect(document.documentElement.style.getPropertyValue("--series-8")).toBe(
    "#ddaa33",
  );
  expect(resolvePalette()).toBe(rendered);
  applyPreferences({ ...prefs, plot_font_size: 12 }, document.documentElement);
  invalidatePalette();
  expect(resolvePalette().contour).toBe(rendered.contour);
  applyPreferences(
    { ...prefs, contour_reversed: false },
    document.documentElement,
  );
  invalidatePalette();
  expect(sampleContour(resolvePalette().contour ?? DEFAULT_CONTOUR, 0)).toEqual(
    [0, 0, 0, 1],
  );
});
