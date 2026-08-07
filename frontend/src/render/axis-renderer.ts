import type { AxisStyle } from "../generated/session";
import type { PlotLayout, Range } from "../app/plot-math";
import { CanvasSurface } from "./surface";
import { COLOR_SLOTS, SERIES_TOKENS } from "./palette";

export { COLOR_SLOTS, SERIES_TOKENS };

export interface AxisPalette {
  background: string;
  fg2: string;
  fg3: string;
  grid: string;
  fontPlot: string;
  fontSize: number;
}

export class AxisRenderer {
  private readonly surface: CanvasSurface;
  private palette: AxisPalette | null = null;
  private layout: PlotLayout | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.surface = new CanvasSurface(canvas);
  }

  lastLayout(): PlotLayout | null {
    return this.layout;
  }

  invalidateTheme(): void {
    this.palette = null;
  }

  setPalette(palette: AxisPalette): void {
    this.palette = palette;
  }

  render(
    xRange: Range,
    yRange: Range,
    xLabel: string,
    yLabel: string,
    axisStyle: AxisStyle = "gutter",
  ): number {
    const started = performance.now();
    const { context, width, height } = this.surface.prepare();
    const colors = this.resolvePalette();
    context.fillStyle = colors.background;
    context.fillRect(0, 0, width, height);
    context.font = tickFont(colors);
    const charWidth = context.measureText("0").width;
    const inline = axisStyle === "inline";
    const plot = inline
      ? { x: 0, y: 0, width, height }
      : {
          x: gutterWidth(
            formatTicks(ticks(yRange.min, yRange.max, 6)),
            charWidth,
          ),
          y: 8,
          width: Math.max(
            1,
            width -
              gutterWidth(
                formatTicks(ticks(yRange.min, yRange.max, 6)),
                charWidth,
              ) -
              12,
          ),
          height: Math.max(1, height - 42),
        };
    this.layout = { plot, xRange: { ...xRange }, yRange: { ...yRange } };
    this.drawGrid(context, colors, plot, xRange, yRange);
    if (inline)
      this.drawInline(context, colors, plot, xRange, yRange, xLabel, yLabel);
    else this.drawGutter(context, colors, plot, xRange, yRange, xLabel, yLabel);
    return performance.now() - started;
  }

  private resolvePalette(): AxisPalette {
    if (this.palette !== null) return this.palette;
    const styles = getComputedStyle(document.documentElement);
    this.palette = {
      background: styles.getPropertyValue("--surface-0").trim(),
      fg2: styles.getPropertyValue("--fg-2").trim(),
      fg3: styles.getPropertyValue("--fg-3").trim(),
      grid: styles.getPropertyValue("--grid").trim(),
      fontPlot:
        styles.getPropertyValue("--font-plot").trim() ||
        '"JetBrains Mono", monospace',
      fontSize:
        Number.parseFloat(styles.getPropertyValue("--plot-font-size")) || 9,
    };
    return this.palette;
  }

  private drawGrid(
    context: CanvasRenderingContext2D,
    colors: AxisPalette,
    plot: PlotLayout["plot"],
    xRange: Range,
    yRange: Range,
  ): void {
    const projectX = (value: number): number =>
      plot.x + ((value - xRange.min) / (xRange.max - xRange.min)) * plot.width;
    const projectY = (value: number): number =>
      plot.y +
      plot.height -
      ((value - yRange.min) / (yRange.max - yRange.min)) * plot.height;
    context.lineWidth = 1;
    context.strokeStyle = colors.grid;
    for (const value of ticks(xRange.min, xRange.max, 7)) {
      const x = Math.round(projectX(value)) + 0.5;
      context.beginPath();
      context.moveTo(x, plot.y);
      context.lineTo(x, plot.y + plot.height);
      context.stroke();
    }
    for (const value of ticks(yRange.min, yRange.max, 6)) {
      const y = Math.round(projectY(value)) + 0.5;
      context.beginPath();
      context.moveTo(plot.x, y);
      context.lineTo(plot.x + plot.width, y);
      context.stroke();
    }
  }

  private drawGutter(
    context: CanvasRenderingContext2D,
    colors: AxisPalette,
    plot: PlotLayout["plot"],
    xRange: Range,
    yRange: Range,
    xLabel: string,
    yLabel: string,
  ): void {
    const toX = (value: number): number =>
      plot.x + ((value - xRange.min) / (xRange.max - xRange.min)) * plot.width;
    const toY = (value: number): number =>
      plot.y +
      plot.height -
      ((value - yRange.min) / (yRange.max - yRange.min)) * plot.height;
    context.fillStyle = colors.fg2;
    context.font = tickFont(colors);
    context.textBaseline = "middle";
    context.textAlign = "center";
    const xValues = ticks(xRange.min, xRange.max, 7);
    xValues.forEach((value, index) =>
      context.fillText(
        formatTicks(xValues)[index] ?? "",
        Math.round(toX(value)) + 0.5,
        plot.y + plot.height + 12,
      ),
    );
    context.textAlign = "right";
    const yValues = ticks(yRange.min, yRange.max, 6);
    yValues.forEach((value, index) =>
      context.fillText(
        formatTicks(yValues)[index] ?? "",
        plot.x - 11,
        Math.round(toY(value)) + 0.5,
      ),
    );
    context.strokeStyle = colors.fg3;
    context.beginPath();
    context.moveTo(plot.x + 0.5, plot.y);
    context.lineTo(plot.x + 0.5, plot.y + plot.height + 0.5);
    context.lineTo(plot.x + plot.width, plot.y + plot.height + 0.5);
    context.stroke();
    context.font = labelFont(colors);
    context.textAlign = "center";
    context.fillText(
      xLabel,
      plot.x + plot.width / 2,
      plot.y + plot.height + 27,
    );
    context.save();
    context.translate(10, plot.y + plot.height / 2);
    context.rotate(-Math.PI / 2);
    context.fillText(yLabel, 0, 0);
    context.restore();
  }

  private drawInline(
    context: CanvasRenderingContext2D,
    colors: AxisPalette,
    plot: PlotLayout["plot"],
    xRange: Range,
    yRange: Range,
    xLabel: string,
    yLabel: string,
  ): void {
    context.fillStyle = colors.fg2;
    context.font = tickFont(colors);
    context.textBaseline = "middle";
    const xValues = ticks(xRange.min, xRange.max, 7);
    const yValues = ticks(yRange.min, yRange.max, 6);
    const toX = (value: number): number =>
      plot.x + ((value - xRange.min) / (xRange.max - xRange.min)) * plot.width;
    const toY = (value: number): number =>
      plot.y +
      plot.height -
      ((value - yRange.min) / (yRange.max - yRange.min)) * plot.height;
    context.textAlign = "center";
    xValues.forEach((value, index) =>
      context.fillText(
        formatTicks(xValues)[index] ?? "",
        toX(value),
        plot.height - 8,
      ),
    );
    context.textAlign = "left";
    yValues.forEach((value, index) =>
      context.fillText(formatTicks(yValues)[index] ?? "", 4, toY(value)),
    );
    context.fillText(yLabel, 4, 12);
    context.textAlign = "right";
    context.fillText(xLabel, plot.width - 4, plot.height - 8);
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
  for (let value = start; value <= max + step * 1e-9; value += step)
    values.push(Math.abs(value) < step * 1e-9 ? 0 : value);
  return values;
}

export function formatTicks(values: readonly number[]): string[] {
  return values.map((value) => {
    const text =
      Math.abs(value) >= 10_000 ? value.toExponential(1) : value.toFixed(2);
    return text.replace(/^-/, "−");
  });
}

export function gutterWidth(
  labels: readonly string[],
  charWidth: number,
): number {
  const longest = labels.reduce((max, label) => Math.max(max, label.length), 0);
  return Math.max(48, Math.ceil(longest * charWidth) + 24);
}

export function tickFont(
  colors: Pick<AxisPalette, "fontPlot" | "fontSize">,
): string {
  return `${String(colors.fontSize)}px ${colors.fontPlot}`;
}

export function labelFont(
  colors: Pick<AxisPalette, "fontPlot" | "fontSize">,
): string {
  return `${String(colors.fontSize + 0.5)}px ${colors.fontPlot}`;
}
