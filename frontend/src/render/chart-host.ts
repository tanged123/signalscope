import {
  ChartGPU,
  type ChartGPUInstance,
  type ChartGPUOptions,
  type LineSeriesConfig,
} from "@chartgpu/chartgpu";
import type { ColumnarTileResponse } from "../app/bin-columns";
import type { Range, PlotLayout } from "../app/plot-math";
import { formatTicks, hueIndex } from "./plot-theme";
import type { Palette, SeriesStroke } from "./plot-theme";
import { responseTimeReference } from "./m4-feed";
import type { GpuContext } from "./gpu-context";
import type { PreparedTileBank } from "../app/prepared-tile-bank";

export const CHART_GRID = { left: 60, right: 12, top: 8, bottom: 34 } as const;
const MIN_CHARTGPU_LINE_WIDTH = 2;
const MIN_CHARTGPU_GHOST_WIDTH = 1.5;
const PLOT_LINE_WIDTH_BASELINE = 2;

export interface ChartRenderRequest {
  bank: PreparedTileBank;
  response: ColumnarTileResponse;
  xRange: Range;
  yRange: readonly [number, number];
  xLabel: string;
  yLabel: string;
  styles: readonly SeriesStroke[];
  emphasisIndices: readonly number[];
  palette: Palette;
}

interface SeriesElement {
  columns: object;
  style: SeriesStroke;
  emphasis: boolean;
  /** Opacity depends on whether any series is emphasized, not only this one. */
  emphasisActive: boolean;
  palette: Palette;
  element: LineSeriesConfig;
}

export class ChartHost {
  private readonly chart: ChartGPUInstance;
  private readonly unregister: () => void;
  private tRef = 0;
  private seriesIds: string[] = [];
  private elements: SeriesElement[] = [];
  private options: ChartGPUOptions | null = null;
  private lastLayout: PlotLayout | null = null;
  private lastLabels: { x: string; y: string } | null = null;

  private constructor(
    private readonly container: HTMLElement,
    chart: ChartGPUInstance,
    gpu: GpuContext,
  ) {
    this.chart = chart;
    this.unregister = gpu.register({
      needsRender: () => this.chart.needsRender(),
      renderFrame: () => {
        this.chart.renderFrame();
      },
    });
  }

  static async create(
    container: HTMLElement,
    gpu: GpuContext,
  ): Promise<ChartHost> {
    const chart = await ChartGPU.create(
      container,
      {
        animation: false,
        renderMode: "external",
        tooltip: { show: false },
        grid: CHART_GRID,
        series: [],
      },
      {
        adapter: gpu.adapter,
        device: gpu.device,
        pipelineCache: gpu.pipelineCache,
      },
    );
    return new ChartHost(container, chart, gpu);
  }

  render(request: ChartRenderRequest): number {
    const started = performance.now();
    const ids = request.response.series.map((series) => series.signalId);
    const nextTRef = responseTimeReference(request.response);
    let rebuilt = false;
    if (!sameStrings(ids, this.seriesIds) || nextTRef !== this.tRef) {
      this.seriesIds = ids;
      this.tRef = nextTRef;
      this.elements = [];
      rebuilt = true;
    }
    const emphasis = new Set(request.emphasisIndices);
    const emphasisActive = request.emphasisIndices.length > 0;
    const series = request.response.series.map((tile, index) => {
      const style = request.styles[index] ?? {
        hue: null,
        dash: "solid",
        width: 1.4,
        alpha: 1,
      };
      const isEmphasized = emphasis.has(index);
      const previous = this.elements[index];
      if (
        previous !== undefined &&
        previous.columns === tile.bins &&
        sameStyle(previous.style, style) &&
        previous.emphasis === isEmphasized &&
        previous.emphasisActive === emphasisActive &&
        previous.palette === request.palette
      ) {
        return previous.element;
      }
      rebuilt = true;
      const hue = style.hue;
      const ghost = hue === null;
      const color = ghost
        ? request.palette.fg4
        : (request.palette.series[hueIndex(hue)] ?? request.palette.fg4);
      const opacity =
        emphasisActive && !isEmphasized && !ghost
          ? 0.25
          : Math.min(1, style.alpha + (isEmphasized ? 0.4 : 0));
      const minimumWidth = ghost
        ? MIN_CHARTGPU_GHOST_WIDTH
        : MIN_CHARTGPU_LINE_WIDTH;
      const width =
        (Math.max(style.width, minimumWidth) + (isEmphasized ? 0.4 : 0)) *
        PLOT_LINE_WIDTH_BASELINE *
        request.palette.lineWidthScale;
      const element: LineSeriesConfig = {
        type: "line",
        name: tile.signalPath,
        data:
          request.bank.feeds[index] ??
          (() => {
            throw new Error(`prepared bank is missing feed ${String(index)}`);
          })(),
        sampling: "none",
        color,
        lineStyle: {
          color,
          width,
          opacity,
        },
      };
      this.elements[index] = {
        columns: tile.bins,
        style,
        emphasis: isEmphasized,
        emphasisActive,
        palette: request.palette,
        element,
      };
      return element;
    });
    this.elements.length = series.length;
    const labelsChanged =
      this.lastLabels === null ||
      this.lastLabels.x !== request.xLabel ||
      this.lastLabels.y !== request.yLabel;
    if (!rebuilt && !labelsChanged && this.options !== null) {
      this.setRangesOnly(request.xRange, request.yRange);
      return performance.now() - started;
    }
    this.lastLabels = { x: request.xLabel, y: request.yLabel };
    const options = this.makeOptions(request, series);
    this.options = options;
    this.chart.setOption(options);
    this.lastLayout = this.makeLayout(request.xRange, request.yRange);
    return performance.now() - started;
  }

  setRangesOnly(xRange: Range, yRange: readonly [number, number]): void {
    if (this.options === null) return;
    this.options = {
      ...this.options,
      xAxis: this.xAxis(xRange, this.options.xAxis?.name ?? "time (s)"),
      yAxis: this.yAxis(yRange, this.options.yAxis?.name ?? "value"),
    };
    this.chart.setOption(this.options);
    this.lastLayout = this.makeLayout(xRange, yRange);
  }

  layout(): PlotLayout | null {
    return this.lastLayout;
  }

  residentGpuBytes(): number {
    const metricsHost = this.chart as unknown as {
      getPerformanceMetrics?(): { memory: { used: number } } | null;
    };
    return metricsHost.getPerformanceMetrics?.()?.memory.used ?? 0;
  }

  async capture(): Promise<HTMLCanvasElement> {
    if (this.options !== null) this.chart.setOption({ ...this.options });
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        this.chart.renderFrame();
        const sources = Array.from(this.container.querySelectorAll("canvas"));
        const target = document.createElement("canvas");
        target.width = sources[0]?.width ?? 1;
        target.height = sources[0]?.height ?? 1;
        const context = target.getContext("2d");
        if (context !== null) {
          for (const source of sources) context.drawImage(source, 0, 0);
        }
        resolve(target);
      });
    });
  }

  resize(): void {
    this.chart.resize();
    if (this.lastLayout !== null) {
      this.lastLayout = this.makeLayout(this.lastLayout.xRange, [
        this.lastLayout.yRange.min,
        this.lastLayout.yRange.max,
      ]);
    }
  }

  dispose(): void {
    this.unregister();
    this.chart.dispose();
  }

  private makeOptions(
    request: ChartRenderRequest,
    series: readonly LineSeriesConfig[],
  ): ChartGPUOptions {
    return {
      animation: false,
      renderMode: "external",
      tooltip: { show: false },
      theme: {
        backgroundColor: request.palette.background,
        textColor: request.palette.fg2,
        axisLineColor: request.palette.border,
        axisTickColor: request.palette.fg3,
        gridLineColor: request.palette.grid,
        colorPalette: request.palette.series,
        fontFamily: request.palette.fontPlot,
        fontSize: request.palette.fontSize,
      },
      palette: request.palette.series,
      grid: CHART_GRID,
      gridLines: { show: true, color: request.palette.grid },
      xAxis: this.xAxis(request.xRange, request.xLabel),
      yAxis: this.yAxis(request.yRange, request.yLabel),
      series,
    };
  }

  private xAxis(
    range: Range,
    label: string,
  ): NonNullable<ChartGPUOptions["xAxis"]> {
    return {
      type: "value",
      name: label,
      min: range.min - this.tRef,
      max: range.max - this.tRef,
      tickFormatter: (value) => formatTicks([value + this.tRef])[0] ?? null,
    };
  }

  private yAxis(
    range: readonly [number, number],
    label: string,
  ): NonNullable<ChartGPUOptions["yAxis"]> {
    return {
      type: "value",
      name: label,
      min: range[0],
      max: range[1],
      tickFormatter: (value) => formatTicks([value])[0] ?? null,
    };
  }

  private makeLayout(
    xRange: Range,
    yRange: readonly [number, number],
  ): PlotLayout {
    return {
      plot: {
        x: CHART_GRID.left,
        y: CHART_GRID.top,
        width: Math.max(
          1,
          this.container.clientWidth - CHART_GRID.left - CHART_GRID.right,
        ),
        height: Math.max(
          1,
          this.container.clientHeight - CHART_GRID.top - CHART_GRID.bottom,
        ),
      },
      xRange,
      yRange: { min: yRange[0], max: yRange[1] },
    };
  }
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameStyle(left: SeriesStroke, right: SeriesStroke): boolean {
  return (
    left.hue === right.hue &&
    left.dash === right.dash &&
    left.width === right.width &&
    left.alpha === right.alpha
  );
}
