import {
  defaultPreferences,
  FONT_FAMILIES,
  fontLabel,
  PLOT_FONT_SIZE,
  PLOT_LINE_WIDTH_SCALE,
  UI_FONT_SIZE,
} from "../app/preferences";
import {
  COLOR_PALETTES,
  CONTOUR_PALETTES,
  palettePreferences,
} from "../app/palettes";
import type { Preferences } from "../generated/preferences";
import type { PaletteEntry } from "./command-palette";
import { THEMES } from "../app/themes";

export function settingsEntries(
  prefs: Preferences,
  update: (patch: Partial<Preferences>) => void,
  openThemes: () => void,
  recipeEntries: PaletteEntry[],
  openPalette: (kind: "color" | "contour") => void,
): PaletteEntry[] {
  const cycleFont = (key: "ui_font_family" | "plot_font_family"): void => {
    const index = FONT_FAMILIES.indexOf(prefs[key]);
    const next = FONT_FAMILIES[(index + 1) % FONT_FAMILIES.length] ?? "inter";
    update({ [key]: next });
  };
  const sizeEntry = (
    title: string,
    key: "ui_font_size" | "plot_font_size",
    step: number,
  ): PaletteEntry => ({
    title,
    hint: `${String(prefs[key])}px`,
    keepOpen: true,
    run: () => {
      update({ [key]: prefs[key] + step });
    },
    adjust: (direction) => {
      update({ [key]: prefs[key] + direction * step });
    },
  });
  return [
    {
      title: "Theme",
      hint: THEMES[prefs.theme].label,
      run: openThemes,
    },
    ...recipeEntries,
    {
      title: "Color palette",
      hint:
        prefs.color_palette === "custom"
          ? "Custom"
          : COLOR_PALETTES[prefs.color_palette].label,
      run: () => openPalette("color"),
    },
    {
      title: "Contour palette",
      hint:
        (prefs.contour_palette === "custom"
          ? "Custom"
          : CONTOUR_PALETTES[prefs.contour_palette].label) +
        (prefs.contour_reversed ? " · Reversed" : ""),
      run: () => openPalette("contour"),
    },
    {
      title: "UI font",
      hint: fontLabel(prefs.ui_font_family),
      keepOpen: true,
      run: () => {
        cycleFont("ui_font_family");
      },
    },
    {
      title: "Plot font",
      hint: fontLabel(prefs.plot_font_family),
      keepOpen: true,
      run: () => {
        cycleFont("plot_font_family");
      },
    },
    sizeEntry("UI font size", "ui_font_size", UI_FONT_SIZE.step),
    sizeEntry("Plot font size", "plot_font_size", PLOT_FONT_SIZE.step),
    {
      title: "Plot line width",
      hint: `${String(Math.round(prefs.plot_line_width_scale * 100))}%`,
      keepOpen: true,
      run: () => {
        update({
          plot_line_width_scale:
            prefs.plot_line_width_scale + PLOT_LINE_WIDTH_SCALE.step,
        });
      },
      adjust: (direction) => {
        update({
          plot_line_width_scale:
            prefs.plot_line_width_scale +
            direction * PLOT_LINE_WIDTH_SCALE.step,
        });
      },
    },
    {
      title: "Reset appearance to defaults",
      hint: "",
      keepOpen: true,
      run: () => {
        const defaults = defaultPreferences();
        update({
          ...palettePreferences(defaults),
          ui_font_family: defaults.ui_font_family,
          plot_font_family: defaults.plot_font_family,
          ui_font_size: defaults.ui_font_size,
          plot_font_size: defaults.plot_font_size,
          plot_line_width_scale: defaults.plot_line_width_scale,
        });
      },
    },
  ];
}
