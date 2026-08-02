import type { SignalTile, TileResponse } from "../generated/protocol";
import type { AxisStyle, DashStyle } from "../generated/session";
import {
  logTicks,
  projectX,
  projectY,
  type AxisScale,
  type PlotLayout,
  type PlotRect,
  type Range,
} from "../app/plot-math";
import { ColormapRamp, SEQ_TOKENS } from "../app/colormap";
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
  sequential: string[];
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
}

export interface SeriesStroke {
  hue: number | null;
  dash: DashStyle;
  width: number;
  alpha: number;
}

export interface PlotPath {
  /** Flat vertex pairs `[x0, y0, x1, y1, …]`; a NaN vertex lifts the pen. */
  points: readonly number[];
  colorIndex: number;
  dash: DashStyle;
  width: number;
  /** Drawn in `--fg-4` at low alpha: present but outside the window. */
  dimmed?: boolean;
  /** Filled sample dots, for sparse traces. */
  markers?: boolean;
  /** Per-vertex scalar driving the sequential ramp; enables `c:` colouring. */
  colorValues?: readonly number[];
}

export interface PathRenderOptions {
  xLabel: string;
  yLabel: string;
  xRange: readonly [number, number];
  yRange: readonly [number, number];
  axisStyle?: AxisStyle;
  xScale?: AxisScale;
  /** Domain and axis name of the `c:` channel; reserves the right gutter. */
  colorbar?: { min: number; max: number; label: string };
}

/** Sample dots appear only when vertices are sparser than this pixel gap. */
const MARKER_PIXEL_GAP = 7;
/** Spec F2: 64px right gutter — 12px bar, ticks, labels, and slack. */
const COLORBAR_GUTTER = 64;

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
  xScale?: AxisScale;
  /** Pixels reserved on the right for a decoration such as the colorbar. */
  rightGutter?: number;
}

export class CanvasRenderer {
  private palette: Palette | null = null;
  private readonly surface: CanvasSurface;
  private layout: PlotLayout | null = null;
  private colorbarGradient: CanvasGradient | null = null;
  private colorbarBottom = 0;
  private sequentialRamp: ColormapRamp | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.surface = new CanvasSurface(canvas);
  }

  invalidateTheme(): void {
    this.palette = null;
    this.colorbarGradient = null;
    this.sequentialRamp = null;
  }

  private ramp(colors: Palette): ColormapRamp {
    this.sequentialRamp ??= new ColormapRamp(colors.sequential);
    return this.sequentialRamp;
  }

  /**
   * Supply the palette directly instead of reading CSS custom properties.
   * `invalidateTheme()` discards it and returns to reading the document.
   */
  setPalette(palette: Palette): void {
    this.palette = palette;
    this.colorbarGradient = null;
    this.sequentialRamp = null;
  }

  lastLayout(): PlotLayout | null {
    return this.layout;
  }

  render(
    response: TileResponse,
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
    response.series.forEach((series, index) => {
      const stroke = options.styles?.[index] ?? {
        hue: (index % COLOR_SLOTS) + 1,
        dash: "solid" as const,
        width: 1.4,
        alpha: 1,
      };
      const ghost = stroke.hue === null;
      const emphasized = options.emphasisIndex === index;
      const color =
        stroke.hue === null
          ? colors.fg4
          : (colors.series[hueIndex(stroke.hue)] ?? colors.fg2);
      const alpha = emphasized
        ? Math.min(1, stroke.alpha + 0.4)
        : options.emphasisIndex !== undefined && !ghost
          ? 0.25
          : stroke.alpha;
      this.drawSeries(
        context,
        plot,
        project,
        series,
        color,
        stroke.dash,
        stroke.width + (emphasized ? 0.4 : 0),
        alpha,
      );
    });
    finishAxes();
    return performance.now() - started;
  }

  /**
   * Draws vertex paths against arbitrary axes. XY trajectories, spectra, and
   * histogram outlines are all vertex arrays rather than envelope bins, so
   * they share this entry point instead of `render()`.
   */
  renderPaths(paths: readonly PlotPath[], options: PathRenderOptions): number {
    const started = performance.now();
    const { context, colors, plot, project, width, height, finishAxes } =
      this.beginFrame({
        xRange: { min: options.xRange[0], max: options.xRange[1] },
        yRange: { min: options.yRange[0], max: options.yRange[1] },
        xLabel: options.xLabel,
        yLabel: options.yLabel,
        ...(options.axisStyle === undefined
          ? {}
          : { axisStyle: options.axisStyle }),
        ...(options.xScale === undefined ? {} : { xScale: options.xScale }),
        ...(options.colorbar === undefined
          ? {}
          : { rightGutter: COLORBAR_GUTTER }),
      });
    for (const path of paths) {
      this.drawPath(context, plot, project, path, colors);
    }
    finishAxes();
    if (options.colorbar !== undefined) {
      // Inline axes give the plot the full canvas height; the bar keeps the
      // gutter layout's vertical insets so its ticks stay readable.
      const colorbarPlot =
        options.axisStyle === "inline"
          ? { ...plot, y: 8, height: Math.max(1, height - 42) }
          : plot;
      this.drawColorbar(context, colorbarPlot, width, options.colorbar, colors);
    }
    return performance.now() - started;
  }

  /**
   * Clears the canvas, derives the plot rectangle, publishes `this.layout`,
   * and draws the axis grid. Both entry points share it so the spec's
   * plot insets and tick policy live in exactly one place.
   */
  private beginFrame(spec: FrameSpec): Frame {
    const { context, width, height } = this.surface.prepare();
    const colors = this.resolvePalette();
    context.fillStyle = colors.background;
    context.fillRect(0, 0, width, height);
    context.font = tickFont(colors);
    const gutter = gutterWidth(
      formatTicks(ticks(spec.yRange.min, spec.yRange.max, 6)),
      context.measureText("0").width,
    );
    const inline = spec.axisStyle === "inline";
    const rightGutter = spec.rightGutter ?? 0;
    const plot: PlotRect = inline
      ? { x: 0, y: 0, width: Math.max(1, width - rightGutter), height }
      : {
          x: gutter,
          y: 8,
          width: Math.max(1, width - gutter - 12 - rightGutter),
          height: Math.max(1, height - 42),
        };
    const scale: AxisScale = spec.xScale ?? "linear";
    const layout: PlotLayout = {
      plot,
      xRange: { ...spec.xRange },
      yRange: { ...spec.yRange },
      xScale: scale,
    };
    this.layout = layout;
    const project: Projection = {
      toX: (value) => projectX(layout, value),
      toY: (value) => projectY(layout, value),
    };
    const xTicks =
      scale === "log"
        ? logTicks(spec.xRange.min, spec.xRange.max)
        : ticks(spec.xRange.min, spec.xRange.max, 7);
    const axes = { context, plot, project, colors, xTicks } as const;
    const labels = { xLabel: spec.xLabel, yLabel: spec.yLabel };
    this.drawGrid(axes, spec.yRange);
    const finishAxes = (): void => {
      if (inline) this.drawInlineFurniture(axes, spec.yRange, labels);
      else this.drawAxisFurniture(axes, spec.yRange, labels);
    };
    return { context, colors, plot, project, width, height, finishAxes };
  }

  private drawPath(
    context: CanvasRenderingContext2D,
    plot: PlotRect,
    project: Projection,
    path: PlotPath,
    colors: Palette,
  ): void {
    const vertices = path.points.length >> 1;
    if (vertices === 0) return;
    context.save();
    context.beginPath();
    context.rect(plot.x, plot.y, plot.width, plot.height);
    context.clip();
    if (path.colorValues !== undefined && path.dimmed !== true) {
      this.drawColorMappedPath(context, project, path, colors);
      context.restore();
      return;
    }
    context.strokeStyle =
      path.dimmed === true
        ? colors.fg3
        : (colors.series[path.colorIndex] ?? colors.fg2);
    context.lineWidth = path.dimmed === true ? 1.2 : path.width;
    context.globalAlpha = path.dimmed === true ? 0.5 : 1;
    context.setLineDash(dashPattern(path.dash));
    context.beginPath();
    let penDown = false;
    for (let index = 0; index < vertices; index += 1) {
      const x = path.points[index * 2] ?? Number.NaN;
      const y = path.points[index * 2 + 1] ?? Number.NaN;
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        penDown = false;
        continue;
      }
      const px = project.toX(x);
      const py = project.toY(y);
      if (penDown) context.lineTo(px, py);
      else context.moveTo(px, py);
      penDown = true;
    }
    context.stroke();
    if (path.markers === true && vertices < plot.width / MARKER_PIXEL_GAP) {
      context.setLineDash([]);
      context.fillStyle = context.strokeStyle;
      context.beginPath();
      for (let index = 0; index < vertices; index += 1) {
        const x = path.points[index * 2] ?? Number.NaN;
        const y = path.points[index * 2 + 1] ?? Number.NaN;
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const px = project.toX(x);
        const py = project.toY(y);
        context.moveTo(px + 2.4, py);
        context.arc(px, py, 2.4, 0, Math.PI * 2);
      }
      context.fill();
    }
    context.globalAlpha = 1;
    context.setLineDash([]);
    context.restore();
  }

  /** Strokes one segment per vertex pair so each carries its own `c:` colour. */
  private drawColorMappedPath(
    context: CanvasRenderingContext2D,
    project: Projection,
    path: PlotPath,
    colors: Palette,
  ): void {
    const values = path.colorValues ?? [];
    const vertices = path.points.length >> 1;
    const ramp = this.ramp(colors);
    context.lineWidth = path.width;
    context.setLineDash(dashPattern(path.dash));
    context.lineCap = "round";
    for (let index = 1; index < vertices; index += 1) {
      const x0 = path.points[(index - 1) * 2] ?? Number.NaN;
      const y0 = path.points[(index - 1) * 2 + 1] ?? Number.NaN;
      const x1 = path.points[index * 2] ?? Number.NaN;
      const y1 = path.points[index * 2 + 1] ?? Number.NaN;
      if (
        !Number.isFinite(x0) ||
        !Number.isFinite(y0) ||
        !Number.isFinite(x1) ||
        !Number.isFinite(y1)
      ) {
        continue;
      }
      // Midpoint of the segment's two scalars keeps the ramp continuous.
      const scalar = ((values[index - 1] ?? 0) + (values[index] ?? 0)) * 0.5;
      context.strokeStyle = ramp.at(scalar);
      context.beginPath();
      context.moveTo(project.toX(x0), project.toY(y0));
      context.lineTo(project.toX(x1), project.toY(y1));
      context.stroke();
    }
    context.lineCap = "butt";
    context.setLineDash([]);
  }

  /**
   * The `c:` colorbar: an axis with full anatomy — 12px bar flush with the
   * plot, 3px ticks at both ends and the midpoint, tabular labels, and its
   * own name in the corner (spec F2).
   */
  private drawColorbar(
    context: CanvasRenderingContext2D,
    plot: PlotRect,
    width: number,
    colorbar: { min: number; max: number; label: string },
    colors: Palette,
  ): void {
    const barX = width - COLORBAR_GUTTER + 24;
    const barWidth = 12;
    // Bottom is the low end, matching the spec's bottom-to-top gradient.
    context.fillStyle = this.colorbarFill(context, plot, colors);
    context.fillRect(barX, plot.y, barWidth, plot.height);
    context.strokeStyle = colors.border;
    context.lineWidth = 1;
    context.strokeRect(barX + 0.5, plot.y + 0.5, barWidth, plot.height);
    context.beginPath();
    for (const fraction of [0, 0.5, 1]) {
      const y = Math.round(plot.y + plot.height * fraction) + 0.5;
      context.moveTo(barX + barWidth, y);
      context.lineTo(barX + barWidth + 3, y);
    }
    context.strokeStyle = colors.fg3;
    context.stroke();
    context.font = tickFont(colors);
    context.fillStyle = colors.fg3;
    context.textAlign = "right";
    context.textBaseline = "middle";
    const span = colorbar.max - colorbar.min;
    const fractions = [0, 0.5, 1];
    const values = fractions.map((fraction) => colorbar.max - span * fraction);
    const labels = formatTicks(values);
    fractions.forEach((fraction, index) => {
      context.fillText(
        labels[index] ?? "",
        width - 2,
        plot.y + plot.height * fraction,
      );
    });
    context.font = labelFont(colors);
    context.fillStyle = colors.fg2;
    context.save();
    context.translate(barX - 8, plot.y + plot.height / 2);
    context.rotate(-Math.PI / 2);
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(colorbar.label, 0, 0);
    context.restore();
  }

  /**
   * The sequential ramp as a canvas gradient. Cached because the bar is
   * otherwise one `fillRect` and one hex interpolation per pixel row, on
   * every XY frame that carries a `c:` channel.
   */
  private colorbarFill(
    context: CanvasRenderingContext2D,
    plot: PlotRect,
    colors: Palette,
  ): CanvasGradient | string {
    const stops = colors.sequential;
    if (stops.length === 0) return "#000000";
    const bottom = plot.y + plot.height;
    if (this.colorbarGradient !== null && this.colorbarBottom === bottom) {
      return this.colorbarGradient;
    }
    const gradient = context.createLinearGradient(0, bottom, 0, plot.y);
    const last = Math.max(1, stops.length - 1);
    stops.forEach((stop, index) => {
      gradient.addColorStop(index / last, stop);
    });
    this.colorbarGradient = gradient;
    this.colorbarBottom = bottom;
    return gradient;
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
      sequential: SEQ_TOKENS.map((token) =>
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
    plot: PlotRect,
    project: Projection,
    series: SignalTile,
    color: string,
    dash: DashStyle,
    width: number,
    alpha: number,
  ): void {
    const { toX, toY } = project;

    context.save();
    context.beginPath();
    context.rect(plot.x, plot.y, plot.width, plot.height);
    context.clip();
    context.strokeStyle = color;
    context.lineWidth = width;
    context.globalAlpha = alpha;
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
    context.globalAlpha = 1;
    context.setLineDash([]);
    context.restore();
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
  return Math.max(52, Math.ceil(longest * charWidth) + 7 + 4 + 12);
}
