import type { AxisStyle, DashStyle } from "../generated/session";
import {
  HAS_FIRST,
  HAS_GAP,
  HAS_LAST,
  HAS_MAX,
  HAS_MIN,
  type BinColumns,
  type ColumnarTile,
  type ColumnarTileResponse,
} from "../app/bin-columns";
import {
  projectX,
  projectY,
  type PlotLayout,
  type PlotRect,
  type Range,
} from "../app/plot-math";
import { CanvasSurface } from "./surface";

interface Projection {
  toX: (value: number) => number;
  toY: (value: number) => number;
}

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
}

export interface RenderOptions {
  xLabel: string;
  yLabel: string;
  yRange: readonly [number, number];
  axisStyle?: AxisStyle;
  styles?: readonly SeriesStroke[];
  emphasisIndex?: number;
  emphasisIndices?: readonly number[];
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
const SOLID: number[] = [];

function hueIndex(hue: number): number {
  return (Math.max(1, Math.trunc(hue)) - 1) % COLOR_SLOTS;
}

function plotFontSize(styles: CSSStyleDeclaration): number {
  const parsed = Number.parseFloat(styles.getPropertyValue("--plot-font-size"));
  return Number.isFinite(parsed) ? parsed : 9;
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

export function dashPattern(dash: DashStyle): number[] {
  if (dash === "dash") return [6, 4];
  if (dash === "dot") return [1.5, 3];
  return [];
}

/** Canvas geometry and palette shared by every draw call in one frame. */
interface Frame {
  context: CanvasRenderingContext2D;
  colors: Palette;
  plot: PlotRect;
  project: Projection;
  width: number;
  height: number;
  finishAxes: () => void;
}

/** What both axis routines draw against, so they share one call shape. */
interface AxisFrame {
  context: CanvasRenderingContext2D;
  plot: PlotRect;
  project: Projection;
  colors: Palette;
  xTicks: readonly number[];
}

/** The axis furniture and geometry one frame needs before anything is drawn. */
interface FrameSpec {
  xRange: Range;
  yRange: Range;
  xLabel: string;
  yLabel: string;
  axisStyle?: AxisStyle;
}

interface ResolvedStroke {
  color: string;
  dash: DashStyle;
  width: number;
  alpha: number;
}

interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
}

export class CanvasRenderer {
  private palette: Palette | null = null;
  private readonly surface: CanvasSurface;
  private pixelRatio = 1;
  private layout: PlotLayout | null = null;
  private lastStroke: string | null = null;
  private lastWidth = Number.NaN;
  private lastAlpha = Number.NaN;
  private lastDash: number[] | null = null;
  private readonly pathCache = new WeakMap<
    BinColumns,
    { key: string; path: Path2D }
  >();

  constructor(canvas: HTMLCanvasElement) {
    this.surface = new CanvasSurface(canvas);
  }

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

  lastLayout(): PlotLayout | null {
    return this.layout;
  }

  render(
    response: ColumnarTileResponse,
    xRange: Range,
    options: RenderOptions,
  ): number {
    const started = performance.now();
    const { context, colors, plot, project, finishAxes } = this.beginFrame({
      xRange,
      yRange: { min: options.yRange[0], max: options.yRange[1] },
      xLabel: options.xLabel,
      yLabel: options.yLabel,
      ...(options.axisStyle === undefined
        ? {}
        : { axisStyle: options.axisStyle }),
    });
    context.save();
    context.beginPath();
    context.rect(plot.x, plot.y, plot.width, plot.height);
    context.clip();
    context.lineJoin = "bevel";
    context.lineCap = "butt";
    const pathKey = [
      xRange.min,
      xRange.max,
      options.yRange[0],
      options.yRange[1],
      plot.x,
      plot.y,
      plot.width,
      plot.height,
      this.pixelRatio,
    ]
      .map(String)
      .join(",");
    const styleFor = (index: number): ResolvedStroke => {
      const stroke = options.styles?.[index] ?? {
        hue: (index % COLOR_SLOTS) + 1,
        dash: "solid" as const,
        width: 1.4,
        alpha: 1,
      };
      const ghost = stroke.hue === null;
      const emphasized =
        options.emphasisIndex === index ||
        (options.emphasisIndices?.includes(index) ?? false);
      const hasEmphasis =
        options.emphasisIndex !== undefined ||
        (options.emphasisIndices?.length ?? 0) > 0;
      const color =
        stroke.hue === null
          ? colors.fg4
          : (colors.series[hueIndex(stroke.hue)] ?? colors.fg2);
      const alpha = emphasized
        ? Math.min(1, stroke.alpha + 0.4)
        : hasEmphasis && !ghost
          ? 0.25
          : stroke.alpha;
      return {
        color,
        dash: stroke.dash,
        width: stroke.width + (emphasized ? 0.4 : 0),
        alpha,
      };
    };
    response.series.forEach((series, index) => {
      this.drawSeries(context, project, series, styleFor(index), pathKey);
    });
    context.restore();
    finishAxes();
    return performance.now() - started;
  }

  /**
   * Clears the canvas, derives the plot rectangle, publishes `this.layout`,
   * and draws the axis grid. Both entry points share it so the spec's
   * plot insets and tick policy live in exactly one place.
   */
  private beginFrame(spec: FrameSpec): Frame {
    const { context, width, height, ratio } = this.surface.prepare();
    this.pixelRatio = ratio;
    this.lastStroke = null;
    this.lastWidth = Number.NaN;
    this.lastAlpha = Number.NaN;
    this.lastDash = null;
    const colors = this.resolvePalette();
    context.fillStyle = colors.background;
    context.fillRect(0, 0, width, height);
    context.font = tickFont(colors);
    const inline = spec.axisStyle === "inline";
    const charWidth = context.measureText("0").width;
    const plotFor = (yRange: Range): PlotRect => {
      if (inline) {
        return { x: 0, y: 0, width, height };
      }
      const gutter = gutterWidth(
        formatTicks(ticks(yRange.min, yRange.max, 6)),
        charWidth,
      );
      return {
        x: gutter,
        y: 8,
        width: Math.max(1, width - gutter - 12),
        height: Math.max(1, height - 42),
      };
    };
    const plot = plotFor(spec.yRange);
    const ranges = { xRange: spec.xRange, yRange: spec.yRange };
    const layout: PlotLayout = {
      plot,
      xRange: { ...ranges.xRange },
      yRange: { ...ranges.yRange },
    };
    this.layout = layout;
    const project: Projection = {
      toX: (value) => projectX(layout, value),
      toY: (value) => projectY(layout, value),
    };
    const xTicks = ticks(ranges.xRange.min, ranges.xRange.max, 7);
    const axes = { context, plot, project, colors, xTicks } as const;
    const labels = { xLabel: spec.xLabel, yLabel: spec.yLabel };
    this.drawGrid(axes, ranges.yRange);
    const finishAxes = (): void => {
      if (inline) this.drawInlineFurniture(axes, ranges.yRange, labels);
      else this.drawAxisFurniture(axes, ranges.yRange, labels);
    };
    return { context, colors, plot, project, width, height, finishAxes };
  }

  private resolvePalette(): Palette {
    if (this.palette !== null) return this.palette;
    const styles = getComputedStyle(document.documentElement);
    this.palette = {
      background: styles.getPropertyValue("--surface-0").trim(),
      border: styles.getPropertyValue("--border-strong").trim(),
      fg2: styles.getPropertyValue("--fg-2").trim(),
      fg3: styles.getPropertyValue("--fg-3").trim(),
      fg4: styles.getPropertyValue("--fg-4").trim(),
      grid: styles.getPropertyValue("--grid").trim(),
      series: SERIES_TOKENS.map((token) =>
        styles.getPropertyValue(token).trim(),
      ),
      fontPlot:
        styles.getPropertyValue("--font-plot").trim() ||
        styles.getPropertyValue("--font-mono").trim() ||
        FALLBACK_MONO,
      fontSize: plotFontSize(styles),
    };
    return this.palette;
  }

  /** Gridlines only; both axis styles share them and both draw them first. */
  private drawGrid(axes: AxisFrame, yRange: Range): void {
    const { context, plot, project, colors, xTicks } = axes;
    const yTicks = ticks(yRange.min, yRange.max, 6);
    context.lineWidth = 1;
    context.strokeStyle = colors.grid;
    for (const value of xTicks) {
      const x = Math.round(project.toX(value)) + 0.5;
      context.beginPath();
      context.moveTo(x, plot.y);
      context.lineTo(x, plot.y + plot.height);
      context.stroke();
    }
    for (const value of yTicks) {
      const y = Math.round(project.toY(value)) + 0.5;
      context.beginPath();
      context.moveTo(plot.x, y);
      context.lineTo(plot.x + plot.width, y);
      context.stroke();
    }
  }

  private drawAxisFurniture(
    axes: AxisFrame,
    yRange: Range,
    labels: { xLabel: string; yLabel: string },
  ): void {
    const { context, plot, project, colors, xTicks } = axes;
    context.lineWidth = 1;
    context.font = tickFont(colors);
    context.textBaseline = "middle";

    const yTicks = ticks(yRange.min, yRange.max, 6);
    const xLabels = formatTicks(xTicks);
    const yLabels = formatTicks(yTicks);
    const { toX, toY } = project;

    context.fillStyle = colors.fg2;
    context.textAlign = "center";
    xTicks.forEach((value, index) => {
      const x = Math.round(toX(value)) + 0.5;
      context.fillText(xLabels[index] ?? "", x, plot.y + plot.height + 12);
    });
    context.textAlign = "right";
    yTicks.forEach((value, index) => {
      const y = Math.round(toY(value)) + 0.5;
      context.fillText(yLabels[index] ?? "", plot.x - 11, y);
    });

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
    context.font = labelFont(colors);
    context.textAlign = "center";
    context.fillText(
      labels.xLabel,
      plot.x + plot.width / 2,
      plot.y + plot.height + 27,
    );
    context.save();
    context.translate(10, plot.y + plot.height / 2);
    context.rotate(-Math.PI / 2);
    context.fillText(labels.yLabel, 0, 0);
    context.restore();
  }

  private drawSeries(
    context: CanvasRenderingContext2D,
    project: Projection,
    series: ColumnarTile,
    style: ResolvedStroke,
    pathKey: string,
  ): void {
    this.setStroke(context, style);
    context.stroke(this.seriesPath(project, series, pathKey));
  }

  private setStroke(
    context: CanvasRenderingContext2D,
    style: ResolvedStroke,
  ): void {
    if (this.lastStroke !== style.color) {
      context.strokeStyle = style.color;
      this.lastStroke = style.color;
    }
    if (this.lastWidth !== style.width) {
      context.lineWidth = style.width;
      this.lastWidth = style.width;
    }
    if (this.lastAlpha !== style.alpha) {
      context.globalAlpha = style.alpha;
      this.lastAlpha = style.alpha;
    }
    const dashPatternValue =
      style.dash === "solid" ? SOLID : dashPattern(style.dash);
    if (this.lastDash !== dashPatternValue) {
      context.setLineDash(dashPatternValue);
      this.lastDash = dashPatternValue;
    }
  }

  private seriesPath(
    project: Projection,
    series: ColumnarTile,
    pathKey: string,
  ): Path2D {
    const bins = series.bins;
    const cached = this.pathCache.get(bins);
    if (cached?.key === pathKey) return cached.path;
    const path = new Path2D();
    this.appendSeriesPath(path, project, bins);
    this.pathCache.set(bins, { key: pathKey, path });
    return path;
  }

  private appendSeriesPath(
    path: PathSink,
    project: Projection,
    bins: BinColumns,
  ): void {
    const { toX, toY } = project;
    let penDown = false;
    const { t0, t1, first, last, min, max, flags, count } = bins;
    const emitColumn = (
      x: number,
      yFirst: number,
      yMin: number,
      yMax: number,
      yLast: number,
      gap: boolean,
    ): void => {
      if (!penDown || gap) {
        path.moveTo(x, yFirst);
      } else {
        path.lineTo(x, yFirst);
      }
      if (yMin !== yMax) {
        if (yMin !== yFirst && yMin !== yLast) path.lineTo(x, yMin);
        if (yMax !== yFirst && yMax !== yLast) path.lineTo(x, yMax);
        path.lineTo(x, yLast);
      } else if (yLast !== yFirst) {
        path.lineTo(x, yLast);
      }
      penDown = !gap;
    };
    for (let index = 0; index < count; index += 1) {
      const binFlags = flags[index] as number;
      if (
        (binFlags & (HAS_FIRST | HAS_LAST | HAS_MIN | HAS_MAX)) !==
        (HAS_FIRST | HAS_LAST | HAS_MIN | HAS_MAX)
      ) {
        penDown = false;
        continue;
      }
      const x = toX(((t0[index] as number) + (t1[index] as number)) * 0.5);
      emitColumn(
        x,
        toY(first[index] as number),
        toY(min[index] as number),
        toY(max[index] as number),
        toY(last[index] as number),
        (binFlags & HAS_GAP) !== 0,
      );
    }
  }

  private drawInlineFurniture(
    axes: AxisFrame,
    yRange: Range,
    labels: { xLabel: string; yLabel: string },
  ): void {
    const { context, plot, project, colors, xTicks } = axes;
    context.lineWidth = 1;
    context.font = tickFont(colors);
    context.textBaseline = "middle";
    const yTicks = ticks(yRange.min, yRange.max, 6);
    const { toX, toY } = project;
    const backed = (
      text: string,
      x: number,
      y: number,
      align: CanvasTextAlign,
    ): void => {
      context.textAlign = align;
      const textWidth = context.measureText(text).width;
      const left =
        align === "left"
          ? x
          : align === "right"
            ? x - textWidth
            : x - textWidth / 2;
      context.save();
      context.globalAlpha = 0.8;
      context.fillStyle = colors.background;
      context.fillRect(left - 3, y - 6, textWidth + 6, 12);
      context.restore();
      context.fillStyle = colors.fg2;
      context.fillText(text, x, y);
    };
    formatTicks(yTicks).forEach((label, index) => {
      const y = toY(yTicks[index] ?? 0);
      if (y > 14 && y < plot.height - 14) backed(label, 4, y, "left");
    });
    formatTicks(xTicks).forEach((label, index) => {
      const x = toX(xTicks[index] ?? 0);
      if (x > 30 && x < plot.width - 30) {
        backed(label, x, plot.height - 8, "center");
      }
    });
    context.font = labelFont(colors);
    backed(labels.yLabel, 4, 12, "left");
    backed(labels.xLabel, plot.width - 4, plot.height - 8, "right");
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

export function gutterWidth(
  labels: readonly string[],
  charWidth: number,
): number {
  const longest = labels.reduce((max, label) => Math.max(max, label.length), 0);
  return Math.max(48, Math.ceil(longest * charWidth) + 24);
}
