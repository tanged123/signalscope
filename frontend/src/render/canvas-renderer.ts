import type { SignalTile, TileResponse } from "../generated/protocol";
import type { DashStyle } from "../generated/session";

interface PlotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Range {
  min: number;
  max: number;
}

export interface Palette {
  background: string;
  border: string;
  fg2: string;
  fg3: string;
  grid: string;
  series: string[];
}

export interface RenderOptions {
  xLabel: string;
  yLabel: string;
  colorSlots: readonly number[];
  dashes: readonly DashStyle[];
  yRange: readonly [number, number];
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

export const COLOR_SLOTS = SERIES_TOKENS.length;

const DASH_CYCLE = ["solid", "dash", "dot"] as const;
const TICK_FONT = '9px "JetBrains Mono", monospace';
const LABEL_FONT = '9.5px "JetBrains Mono", monospace';

export function resolveSeriesStyle(
  colorSlot: number,
  dash: DashStyle,
): { colorIndex: number; dash: DashStyle } {
  const zero = Math.max(0, Math.trunc(colorSlot) - 1);
  const band = Math.floor(zero / COLOR_SLOTS) % DASH_CYCLE.length;
  return {
    colorIndex: zero % COLOR_SLOTS,
    dash: dash === "solid" ? (DASH_CYCLE[band] ?? "solid") : dash,
  };
}

export function dashPattern(dash: DashStyle): number[] {
  if (dash === "dash") return [6, 4];
  if (dash === "dot") return [1.5, 3];
  return [];
}

export class CanvasRenderer {
  private palette: Palette | null = null;
  private renderedWidth = 0;
  private renderedHeight = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  invalidateTheme(): void {
    this.palette = null;
  }

  /**
   * Supply the palette directly instead of reading CSS custom properties.
   * `invalidateTheme()` discards it and returns to reading the document.
   */
  setPalette(palette: Palette): void {
    this.palette = palette;
  }

  render(
    response: TileResponse,
    xRange: Range,
    options: RenderOptions,
  ): number {
    const started = performance.now();
    const { context, width, height } = this.prepareCanvas();
    const colors = this.resolvePalette();
    context.fillStyle = colors.background;
    context.fillRect(0, 0, width, height);

    const yRange: Range = {
      min: options.yRange[0],
      max: options.yRange[1],
    };
    context.font = TICK_FONT;
    const charWidth = context.measureText("0").width;
    const gutter = gutterWidth(
      formatTicks(ticks(yRange.min, yRange.max, 6)),
      charWidth,
    );
    const plot: PlotRect = {
      x: gutter,
      y: 8,
      width: Math.max(1, width - gutter - 12),
      height: Math.max(1, height - 42),
    };
    this.drawAxes(context, plot, xRange, yRange, colors, options);
    response.series.forEach((series, index) => {
      const style = resolveSeriesStyle(
        options.colorSlots[index] ?? index + 1,
        options.dashes[index] ?? "solid",
      );
      this.drawSeries(
        context,
        plot,
        series,
        xRange,
        yRange,
        colors.series[style.colorIndex] ?? colors.fg2,
        style.dash,
      );
    });
    return performance.now() - started;
  }

  private prepareCanvas(): {
    context: CanvasRenderingContext2D;
    width: number;
    height: number;
  } {
    const ratio = globalThis.devicePixelRatio || 1;
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    const backingWidth = Math.round(width * ratio);
    const backingHeight = Math.round(height * ratio);
    if (
      backingWidth !== this.renderedWidth ||
      backingHeight !== this.renderedHeight
    ) {
      this.canvas.width = backingWidth;
      this.canvas.height = backingHeight;
      this.renderedWidth = backingWidth;
      this.renderedHeight = backingHeight;
    }
    const context = this.canvas.getContext("2d");
    if (context === null) {
      throw new Error("Canvas 2D context is unavailable");
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { context, width, height };
  }

  private resolvePalette(): Palette {
    if (this.palette !== null) return this.palette;
    const styles = getComputedStyle(document.documentElement);
    this.palette = {
      background: styles.getPropertyValue("--surface-0").trim(),
      border: styles.getPropertyValue("--border-strong").trim(),
      fg2: styles.getPropertyValue("--fg-2").trim(),
      fg3: styles.getPropertyValue("--fg-3").trim(),
      grid: styles.getPropertyValue("--grid").trim(),
      series: SERIES_TOKENS.map((token) =>
        styles.getPropertyValue(token).trim(),
      ),
    };
    return this.palette;
  }

  private drawAxes(
    context: CanvasRenderingContext2D,
    plot: PlotRect,
    xRange: Range,
    yRange: Range,
    colors: Palette,
    options: RenderOptions,
  ): void {
    context.lineWidth = 1;
    context.font = TICK_FONT;
    context.textBaseline = "middle";

    const xTicks = ticks(xRange.min, xRange.max, 7);
    const yTicks = ticks(yRange.min, yRange.max, 6);
    const xLabels = formatTicks(xTicks);
    const yLabels = formatTicks(yTicks);

    const toX = (value: number): number =>
      plot.x + ((value - xRange.min) / (xRange.max - xRange.min)) * plot.width;
    const toY = (value: number): number =>
      plot.y +
      plot.height -
      ((value - yRange.min) / (yRange.max - yRange.min)) * plot.height;

    context.strokeStyle = colors.grid;
    context.fillStyle = colors.fg2;
    context.textAlign = "center";
    xTicks.forEach((value, index) => {
      const x = Math.round(toX(value)) + 0.5;
      context.beginPath();
      context.moveTo(x, plot.y);
      context.lineTo(x, plot.y + plot.height);
      context.stroke();
      context.fillText(xLabels[index] ?? "", x, plot.y + plot.height + 12);
    });
    context.textAlign = "right";
    yTicks.forEach((value, index) => {
      const y = Math.round(toY(value)) + 0.5;
      context.beginPath();
      context.moveTo(plot.x, y);
      context.lineTo(plot.x + plot.width, y);
      context.stroke();
      context.fillText(yLabels[index] ?? "", plot.x - 11, y);
    });

    if (yRange.min < 0 && yRange.max > 0) {
      const zero = Math.round(toY(0)) + 0.5;
      context.strokeStyle = colors.fg3;
      context.beginPath();
      context.moveTo(plot.x, zero);
      context.lineTo(plot.x + plot.width, zero);
      context.stroke();
    }

    context.strokeStyle = colors.fg3;
    context.beginPath();
    context.moveTo(plot.x + 0.5, plot.y);
    context.lineTo(plot.x + 0.5, plot.y + plot.height + 0.5);
    context.lineTo(plot.x + plot.width, plot.y + plot.height + 0.5);
    for (const value of xTicks) {
      const x = Math.round(toX(value)) + 0.5;
      context.moveTo(x, plot.y + plot.height + 0.5);
      context.lineTo(x, plot.y + plot.height + 4.5);
    }
    for (const value of yTicks) {
      const y = Math.round(toY(value)) + 0.5;
      context.moveTo(plot.x + 0.5, y);
      context.lineTo(plot.x - 3.5, y);
    }
    context.stroke();

    context.fillStyle = colors.fg2;
    context.font = LABEL_FONT;
    context.textAlign = "center";
    context.fillText(
      options.xLabel,
      plot.x + plot.width / 2,
      plot.y + plot.height + 27,
    );
    context.save();
    context.translate(10, plot.y + plot.height / 2);
    context.rotate(-Math.PI / 2);
    context.fillText(options.yLabel, 0, 0);
    context.restore();
  }

  private drawSeries(
    context: CanvasRenderingContext2D,
    plot: PlotRect,
    series: SignalTile,
    xRange: Range,
    yRange: Range,
    color: string,
    dash: DashStyle,
  ): void {
    const toX = (value: number): number =>
      plot.x + ((value - xRange.min) / (xRange.max - xRange.min)) * plot.width;
    const toY = (value: number): number =>
      plot.y +
      plot.height -
      ((value - yRange.min) / (yRange.max - yRange.min)) * plot.height;

    context.strokeStyle = color;
    context.lineWidth = 1.4;
    context.setLineDash(dashPattern(dash));
    context.beginPath();
    let penDown = false;
    for (const bin of series.bins) {
      if (
        bin.first === null ||
        bin.last === null ||
        bin.min === null ||
        bin.max === null
      ) {
        penDown = false;
        continue;
      }
      const x = toX((bin.t0 + bin.t1) * 0.5);
      const firstY = toY(bin.first);
      if (!penDown || bin.has_gap) {
        context.moveTo(x, firstY);
      } else {
        context.lineTo(x, firstY);
      }
      context.lineTo(x, toY(bin.min));
      context.lineTo(x, toY(bin.max));
      context.lineTo(x, toY(bin.last));
      penDown = !bin.has_gap;
    }
    context.stroke();
    context.setLineDash([]);
  }
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
    return values.map((value) => value.toExponential(1));
  }
  let gap = Number.POSITIVE_INFINITY;
  for (let index = 1; index < values.length; index += 1) {
    const step = Math.abs((values[index] ?? 0) - (values[index - 1] ?? 0));
    if (step > 0) gap = Math.min(gap, step);
  }
  const digits = Number.isFinite(gap)
    ? Math.min(6, Math.max(0, Math.ceil(-Math.log10(gap)) + 1))
    : 0;
  return values.map((value) => value.toFixed(digits));
}

export function gutterWidth(
  labels: readonly string[],
  charWidth: number,
): number {
  const longest = labels.reduce((max, label) => Math.max(max, label.length), 0);
  return Math.max(52, Math.ceil(longest * charWidth) + 7 + 4 + 12);
}
