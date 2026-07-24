import type { SignalTile, TileResponse } from "../generated/protocol";

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

interface Palette {
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

export class CanvasRenderer {
  private palette: Palette | null = null;
  private renderedWidth = 0;
  private renderedHeight = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  invalidateTheme(): void {
    this.palette = null;
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

    const plot: PlotRect = {
      x: 52,
      y: 8,
      width: Math.max(1, width - 64),
      height: Math.max(1, height - 42),
    };
    const yRange = visibleYRange(response.series);
    this.drawAxes(context, plot, xRange, yRange, colors, options);
    response.series.forEach((series, index) => {
      const slot = options.colorSlots[index] ?? index + 1;
      this.drawSeries(
        context,
        plot,
        series,
        xRange,
        yRange,
        colors.series[(slot - 1) % colors.series.length] ?? colors.fg2,
      );
    });
    return performance.now() - started;
  }

  private prepareCanvas(): {
    context: CanvasRenderingContext2D;
    width: number;
    height: number;
  } {
    const ratio = window.devicePixelRatio || 1;
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
    context.font = '9px "JetBrains Mono", monospace';
    context.textBaseline = "middle";
    context.strokeStyle = colors.grid;
    context.fillStyle = colors.fg3;

    const xTicks = ticks(xRange.min, xRange.max, 7);
    const yTicks = ticks(yRange.min, yRange.max, 6);
    for (const value of xTicks) {
      const x =
        plot.x +
        ((value - xRange.min) / (xRange.max - xRange.min)) * plot.width;
      context.beginPath();
      context.moveTo(Math.round(x) + 0.5, plot.y);
      context.lineTo(Math.round(x) + 0.5, plot.y + plot.height);
      context.stroke();
      context.fillText(formatTick(value), x, plot.y + plot.height + 12);
    }
    context.textAlign = "right";
    for (const value of yTicks) {
      const y =
        plot.y +
        plot.height -
        ((value - yRange.min) / (yRange.max - yRange.min)) * plot.height;
      context.beginPath();
      context.moveTo(plot.x, Math.round(y) + 0.5);
      context.lineTo(plot.x + plot.width, Math.round(y) + 0.5);
      context.stroke();
      context.fillText(formatTick(value), plot.x - 7, y);
    }

    context.strokeStyle = colors.fg3;
    context.beginPath();
    context.moveTo(plot.x + 0.5, plot.y);
    context.lineTo(plot.x + 0.5, plot.y + plot.height + 0.5);
    context.lineTo(plot.x + plot.width, plot.y + plot.height + 0.5);
    context.stroke();

    context.fillStyle = colors.fg2;
    context.font = '9.5px "JetBrains Mono", monospace';
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
  ): void {
    const toX = (value: number): number =>
      plot.x + ((value - xRange.min) / (xRange.max - xRange.min)) * plot.width;
    const toY = (value: number): number =>
      plot.y +
      plot.height -
      ((value - yRange.min) / (yRange.max - yRange.min)) * plot.height;

    context.strokeStyle = color;
    context.lineWidth = 1.4;
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
  }
}

function visibleYRange(series: SignalTile[]): Range {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const item of series) {
    for (const bin of item.bins) {
      if (bin.min !== null) min = Math.min(min, bin.min);
      if (bin.max !== null) max = Math.max(max, bin.max);
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: -1, max: 1 };
  }
  if (min === max) {
    return { min: min - 1, max: max + 1 };
  }
  const padding = (max - min) * 0.06;
  return { min: min - padding, max: max + padding };
}

function ticks(min: number, max: number, count: number): number[] {
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

function formatTick(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 10_000 || (absolute > 0 && absolute < 0.001)) {
    return value.toExponential(1);
  }
  return value.toFixed(absolute < 10 ? 2 : absolute < 100 ? 1 : 0);
}
