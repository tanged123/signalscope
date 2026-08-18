import type { DashStyle } from "../generated/session";

export interface Palette {
  background: string;
  border: string;
  fg2: string;
  fg3: string;
  fg4: string;
  grid: string;
  series: string[];
  fontPlot: string;
  fontSize: number;
  lineWidthScale: number;
}

export interface SeriesStroke {
  hue: number | null;
  dash: DashStyle;
  width: number;
  alpha: number;
}

export const SERIES_TOKENS = [
  "--series-1",
  "--series-2",
  "--series-3",
  "--series-4",
  "--series-5",
  "--series-6",
  "--series-7",
  "--series-8",
] as const;

// MATLAB advances line style after exhausting its categorical color order.
// SignalScope keeps --series-8 as the first dashed rollover for compatibility.
export const COLOR_SLOTS = SERIES_TOKENS.length - 1;

const FALLBACK_MONO = '"JetBrains Mono", monospace';
let cached: Palette | null = null;

export function hueIndex(hue: number): number {
  return (Math.max(1, Math.trunc(hue)) - 1) % COLOR_SLOTS;
}

function plotFontSize(styles: CSSStyleDeclaration): number {
  const parsed = Number.parseFloat(styles.getPropertyValue("--plot-font-size"));
  return Number.isFinite(parsed) ? parsed : 9;
}

function plotLineWidthScale(styles: CSSStyleDeclaration): number {
  const parsed = Number.parseFloat(
    styles.getPropertyValue("--plot-line-width-scale"),
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export function tickFont(palette: {
  fontPlot: string;
  fontSize: number;
}): string {
  return `${String(palette.fontSize)}px ${palette.fontPlot}`;
}

export function labelFont(palette: {
  fontPlot: string;
  fontSize: number;
}): string {
  return `${String(palette.fontSize + 0.5)}px ${palette.fontPlot}`;
}

export function invalidatePalette(): void {
  cached = null;
}

export function resolvePalette(): Palette {
  if (cached !== null) return cached;
  const styles = getComputedStyle(document.documentElement);
  cached = {
    background: styles.getPropertyValue("--surface-0").trim(),
    border: styles.getPropertyValue("--border-strong").trim(),
    fg2: styles.getPropertyValue("--fg-2").trim(),
    fg3: styles.getPropertyValue("--fg-3").trim(),
    fg4: styles.getPropertyValue("--fg-4").trim(),
    grid: styles.getPropertyValue("--grid").trim(),
    series: SERIES_TOKENS.map((token) => styles.getPropertyValue(token).trim()),
    fontPlot:
      styles.getPropertyValue("--font-plot").trim() ||
      styles.getPropertyValue("--font-mono").trim() ||
      FALLBACK_MONO,
    fontSize: plotFontSize(styles),
    lineWidthScale: plotLineWidthScale(styles),
  };
  return cached;
}

export function ticks(min: number, max: number, count: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) return [];
  const roughStep = (max - min) / Math.max(1, count - 1);
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  const step =
    (normalized < 1.5 ? 1 : normalized < 3.5 ? 2 : normalized < 7.5 ? 5 : 10) *
    magnitude;
  const start = Math.ceil(min / step) * step;
  const values: number[] = [];
  for (let value = start; value <= max + step * 1e-9; value += step) {
    values.push(Math.abs(value) < step * 1e-9 ? 0 : value);
  }
  return values;
}

export function formatTicks(values: readonly number[]): string[] {
  const magnitudes = values.map(Math.abs).filter((value) => value > 0);
  const largest = magnitudes.length === 0 ? 0 : Math.max(...magnitudes);
  const smallest = magnitudes.length === 0 ? 0 : Math.min(...magnitudes);
  if (largest >= 10_000 || (smallest > 0 && smallest < 0.001)) {
    return values.map((value) => value.toExponential(1).replace(/^-/, "−"));
  }
  let gap = Number.POSITIVE_INFINITY;
  for (let index = 1; index < values.length; index += 1) {
    const step = Math.abs((values[index] ?? 0) - (values[index - 1] ?? 0));
    if (step > 0) gap = Math.min(gap, step);
  }
  const digits = Number.isFinite(gap)
    ? Math.min(6, Math.max(0, Math.ceil(-Math.log10(gap)) + 1))
    : 0;
  return values.map((value) => value.toFixed(digits).replace(/^-/, "−"));
}
