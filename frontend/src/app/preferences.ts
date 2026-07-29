import {
  PREFERENCES_SCHEMA_VERSION,
  type FontFamily,
  type Preferences,
} from "../generated/preferences";

export const UI_FONT_SIZE = { min: 10, max: 20, default: 13, step: 1 } as const;
export const PLOT_FONT_SIZE = {
  min: 6,
  max: 16,
  default: 9,
  step: 0.5,
} as const;

export const FONT_FAMILIES: readonly FontFamily[] = [
  "inter",
  "dejavu",
  "arimo",
  "jetbrains",
];

const FONT_META: Record<FontFamily, { label: string; stack: string }> = {
  inter: {
    label: "Inter",
    stack: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  dejavu: {
    label: "DejaVu Sans (matplotlib)",
    stack: '"DejaVu Sans", Verdana, sans-serif',
  },
  arimo: {
    label: "Arimo (MATLAB-like)",
    stack: 'Arimo, "Liberation Sans", Helvetica, Arial, sans-serif',
  },
  jetbrains: {
    label: "JetBrains Mono",
    stack: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace',
  },
};

export function fontLabel(family: FontFamily): string {
  return FONT_META[family].label;
}

export function fontStack(family: FontFamily): string {
  return FONT_META[family].stack;
}

export function defaultPreferences(): Preferences {
  return {
    schema_version: PREFERENCES_SCHEMA_VERSION,
    ui_font_family: "inter",
    plot_font_family: "jetbrains",
    ui_font_size: UI_FONT_SIZE.default,
    plot_font_size: PLOT_FONT_SIZE.default,
  };
}

export function clampUiFontSize(value: number): number {
  const clamped = Math.min(UI_FONT_SIZE.max, Math.max(UI_FONT_SIZE.min, value));
  return Math.round(clamped);
}

export function clampPlotFontSize(value: number): number {
  const clamped = Math.min(
    PLOT_FONT_SIZE.max,
    Math.max(PLOT_FONT_SIZE.min, value),
  );
  return Math.round(clamped * 2) / 2;
}

/**
 * Parses a stored preferences document. Unknown enum values and
 * out-of-range sizes are repaired to keep a hand-edited file loadable;
 * malformed JSON or an unknown schema version returns null so callers fall
 * back to defaults without overwriting the file.
 */
export function parsePreferences(json: string): Preferences | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const value = parsed as Partial<Preferences>;
  if (value.schema_version !== PREFERENCES_SCHEMA_VERSION) return null;
  const defaults = defaultPreferences();
  const family = (candidate: unknown, fallback: FontFamily): FontFamily =>
    FONT_FAMILIES.includes(candidate as FontFamily)
      ? (candidate as FontFamily)
      : fallback;
  const size = (candidate: unknown, fallback: number): number =>
    typeof candidate === "number" && Number.isFinite(candidate)
      ? candidate
      : fallback;
  return {
    schema_version: PREFERENCES_SCHEMA_VERSION,
    ui_font_family: family(value.ui_font_family, defaults.ui_font_family),
    plot_font_family: family(value.plot_font_family, defaults.plot_font_family),
    ui_font_size: clampUiFontSize(
      size(value.ui_font_size, defaults.ui_font_size),
    ),
    plot_font_size: clampPlotFontSize(
      size(value.plot_font_size, defaults.plot_font_size),
    ),
  };
}

/** The subset of an element the appearance settings write to. */
export interface PreferencesTarget {
  style: {
    setProperty(name: string, value: string): void;
    fontSize: string;
  };
}

/**
 * Pushes preferences into the style system: font-family tokens, the plot
 * font size token the canvas renderers read, and the root font-size that
 * drives every rem-based UI font size.
 */
export function applyPreferences(
  prefs: Preferences,
  target: PreferencesTarget,
): void {
  target.style.setProperty("--font-ui", fontStack(prefs.ui_font_family));
  target.style.setProperty("--font-plot", fontStack(prefs.plot_font_family));
  target.style.setProperty("--plot-font-size", String(prefs.plot_font_size));
  target.style.fontSize = `${String(prefs.ui_font_size)}px`;
}
