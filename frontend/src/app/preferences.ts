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
export const PLOT_LINE_WIDTH_SCALE = {
  min: 0.5,
  max: 2,
  default: 1,
  step: 0.25,
} as const;

export const FONT_FAMILIES: readonly FontFamily[] = [
  "inter",
  "dejavu",
  "arimo",
  "jetbrains",
];
const DEFAULT_CACHE_MAX_BYTES = String(20 * 1024 * 1024 * 1024);

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
    theme: "dark",
    ui_font_family: "inter",
    plot_font_family: "jetbrains",
    ui_font_size: UI_FONT_SIZE.default,
    plot_font_size: PLOT_FONT_SIZE.default,
    plot_line_width_scale: PLOT_LINE_WIDTH_SCALE.default,
    cache_root: null,
    cache_max_bytes: DEFAULT_CACHE_MAX_BYTES,
    ingest_working_bytes: null,
    ingest_resident_bytes: null,
    recipe_directory: null,
    presentation_cpu_bytes: null,
    presentation_gpu_bytes: null,
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

export function clampPlotLineWidthScale(value: number): number {
  const clamped = Math.min(
    PLOT_LINE_WIDTH_SCALE.max,
    Math.max(PLOT_LINE_WIDTH_SCALE.min, value),
  );
  return Math.round(clamped * 4) / 4;
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
  if (
    value.schema_version !== 1 &&
    value.schema_version !== 2 &&
    value.schema_version !== 3 &&
    value.schema_version !== 4 &&
    value.schema_version !== 5 &&
    value.schema_version !== 6 &&
    value.schema_version !== 7
  )
    return null;
  const defaults = defaultPreferences();
  const family = (candidate: unknown, fallback: FontFamily): FontFamily =>
    FONT_FAMILIES.includes(candidate as FontFamily)
      ? (candidate as FontFamily)
      : fallback;
  const size = (candidate: unknown, fallback: number): number =>
    typeof candidate === "number" && Number.isFinite(candidate)
      ? candidate
      : fallback;
  const bytes = (candidate: unknown, fallback: string | null): string | null =>
    typeof candidate === "string" && /^[1-9]\d*$/.test(candidate)
      ? candidate
      : fallback;
  return {
    schema_version: PREFERENCES_SCHEMA_VERSION,
    theme: value.theme === "light" ? "light" : defaults.theme,
    ui_font_family: family(value.ui_font_family, defaults.ui_font_family),
    plot_font_family: family(value.plot_font_family, defaults.plot_font_family),
    ui_font_size: clampUiFontSize(
      size(value.ui_font_size, defaults.ui_font_size),
    ),
    plot_font_size: clampPlotFontSize(
      size(value.plot_font_size, defaults.plot_font_size),
    ),
    plot_line_width_scale: clampPlotLineWidthScale(
      value.schema_version >= 6
        ? size(value.plot_line_width_scale, defaults.plot_line_width_scale)
        : defaults.plot_line_width_scale,
    ),
    cache_root:
      typeof value.cache_root === "string" && value.cache_root.length > 0
        ? value.cache_root
        : null,
    cache_max_bytes:
      bytes(value.cache_max_bytes, defaults.cache_max_bytes) ??
      defaults.cache_max_bytes,
    ingest_working_bytes: bytes(value.ingest_working_bytes, null),
    ingest_resident_bytes: bytes(value.ingest_resident_bytes, null),
    recipe_directory:
      typeof value.recipe_directory === "string" &&
      value.recipe_directory.length > 0
        ? value.recipe_directory
        : null,
    presentation_cpu_bytes: bytes(value.presentation_cpu_bytes, null),
    presentation_gpu_bytes: bytes(value.presentation_gpu_bytes, null),
  };
}

/** The subset of an element the appearance settings write to. */
export interface PreferencesTarget {
  style: {
    setProperty(name: string, value: string): void;
    fontSize: string;
  };
  dataset: DOMStringMap;
}

/**
 * Pushes preferences into the style system: font-family tokens, the plot
 * font size token the plot renderer reads, and the root font-size that
 * drives every rem-based UI font size.
 */
export function applyPreferences(
  prefs: Preferences,
  target: PreferencesTarget,
): void {
  target.dataset.theme = prefs.theme;
  target.style.setProperty("--font-ui", fontStack(prefs.ui_font_family));
  target.style.setProperty("--font-plot", fontStack(prefs.plot_font_family));
  target.style.setProperty("--plot-font-size", String(prefs.plot_font_size));
  target.style.setProperty(
    "--plot-line-width-scale",
    String(prefs.plot_line_width_scale),
  );
  target.style.fontSize = `${String(prefs.ui_font_size)}px`;
}
