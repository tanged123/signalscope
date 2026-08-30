// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { binColumnsFromWire } from "../app/bin-columns";
import type { ColumnarTileResponse } from "../app/bin-columns";
import type { Palette, SeriesStroke } from "./plot-theme";
import type { GpuContext } from "./gpu-context";

const state = vi.hoisted(() => ({
  charts: [] as Array<{
    options: Record<string, unknown>;
    setOption: ReturnType<typeof vi.fn>;
    setViewRange: ReturnType<typeof vi.fn>;
    renderFrame: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    needsRender: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("@chartgpu/chartgpu", () => ({
  ChartGPU: {
    create: vi.fn(
      (container: HTMLElement, options: Record<string, unknown>) => {
        const canvas = document.createElement("canvas");
        canvas.width = 320;
        canvas.height = 180;
        container.appendChild(canvas);
        const chart = {
          options,
          setOption: vi.fn((next: Record<string, unknown>) => {
            chart.options = next;
          }),
          setViewRange: vi.fn(
            (range: {
              x: { min: number; max: number };
              y: { min: number; max: number };
            }) => {
              chart.options = {
                ...chart.options,
                xAxis: { min: range.x.min, max: range.x.max },
                yAxis: { min: range.y.min, max: range.y.max },
              };
            },
          ),
          renderFrame: vi.fn(() => true),
          resize: vi.fn(),
          dispose: vi.fn(),
          needsRender: vi.fn(() => false),
        };
        state.charts.push(chart);
        return Promise.resolve(chart);
      },
    ),
  },
}));

import { CHART_GRID, ChartHost } from "./chart-host";

const palette: Palette = {
  background: "#101010",
  border: "#303030",
  fg2: "#c0c0c0",
  fg3: "#808080",
  fg4: "#505050",
  grid: "#202020",
  series: ["#e65050", "#50a0e6"],
  fontPlot: "JetBrains Mono",
  fontSize: 11,
  lineWidthScale: 1,
};

function response(signalIds = ["signal-1"]): ColumnarTileResponse {
  return {
    requestId: "request-1",
    series: signalIds.map((signalId, index) => ({
      signalId,
      signalPath: `signal_${String(index)}`,
      unit: null,
      level: 0,
      bins: binColumnsFromWire([
        {
          t0: 10,
          t1: 10,
          first: index + 1,
          last: index + 2,
          min: index,
          max: index + 3,
          sum: index + 2,
          sum_sq: 0,
          finite_count: "1",
          sample_count: "1",
          has_gap: false,
        },
      ]),
    })),
  };
}

function stroke(hue: number | null): SeriesStroke {
  return { hue, dash: "solid", width: 1.5, alpha: 1 };
}

function request(
  data: ColumnarTileResponse = response(),
  styles: readonly SeriesStroke[] = [stroke(0)],
  emphasisIndices: readonly number[] = [],
) {
  return {
    response: data,
    xRange: { min: 10, max: 12 },
    yRange: [0, 4] as const,
    xLabel: "time (s)",
    yLabel: "value",
    styles,
    emphasisIndices,
    palette,
  };
}

async function hostFixture(): Promise<ChartHost> {
  const container = document.createElement("div");
  Object.defineProperty(container, "clientWidth", {
    configurable: true,
    value: 400,
  });
  Object.defineProperty(container, "clientHeight", {
    configurable: true,
    value: 300,
  });
  const gpu = {
    adapter: {},
    device: {},
    pipelineCache: {},
    register: vi.fn(() => vi.fn()),
  } as unknown as GpuContext;
  return ChartHost.create(container, gpu);
}

describe("ChartHost", () => {
  it("publishes the configured grid margins", () => {
    expect(CHART_GRID).toEqual({ left: 60, right: 12, top: 8, bottom: 34 });
  });

  it("normalizes time to a stable reference and emits ChartGPU series", async () => {
    const host = await hostFixture();

    host.render(request());

    const options = state.charts.at(-1)?.options ?? {};
    const xAxis = options.xAxis as { min: number; max: number };
    const series = options.series as Array<{ data: Float32Array }>;
    expect(options.legend).toEqual({ show: false });
    expect(xAxis.min).toBe(0);
    expect(xAxis.max).toBe(2);
    expect(series[0]?.data[0]).toBe(0);
  });

  it("rebases time from the earliest first bin without scanning every bin", async () => {
    const host = await hostFixture();
    const series = (signalId: string, starts: number[]) => ({
      signalId,
      signalPath: signalId,
      unit: null,
      level: 0,
      bins: binColumnsFromWire(
        starts.map((t0) => ({
          t0,
          t1: t0,
          first: 1,
          last: 1,
          min: 1,
          max: 1,
          sum: 1,
          sum_sq: 1,
          finite_count: "1",
          sample_count: "1",
          has_gap: false,
        })),
      ),
    });

    host.render({
      ...request(),
      response: {
        requestId: "rebase",
        series: [series("late", [40, 50, 60]), series("early", [25, 35, 45])],
      },
      styles: [stroke(0), stroke(1)],
      xRange: { min: 25, max: 60 },
    });

    const xAxis = (state.charts.at(-1)?.options ?? {}).xAxis as {
      min: number;
      max: number;
    };
    expect(xAxis.min).toBe(0);
    expect(xAxis.max).toBe(35);
  });

  it("rebases the time reference when a window moves far away", async () => {
    const host = await hostFixture();
    host.render(request());

    const moved = response();
    const bins = moved.series[0]?.bins;
    if (bins === undefined) throw new Error("missing test bins");
    bins.t0[0] = 1_000_000;
    bins.t1[0] = 1_000_000;
    host.render({
      ...request(moved),
      xRange: { min: 1_000_000, max: 1_000_002 },
    });

    const options = state.charts.at(-1)?.options ?? {};
    const xAxis = options.xAxis as { min: number; max: number };
    const series = options.series as Array<{ data: Float32Array }>;
    expect(xAxis.min).toBe(0);
    expect(xAxis.max).toBe(2);
    expect(series[0]?.data[0]).toBe(0);
  });

  it("formats rebased X and plain Y singleton ticks from their visible ranges", async () => {
    const host = await hostFixture();
    const data = response();
    const bins = data.series[0]?.bins;
    if (bins === undefined) throw new Error("missing test bins");
    bins.t0[0] = 323;
    bins.t1[0] = 323;

    host.render({
      ...request(data),
      xRange: { min: 323, max: 323.2 },
      yRange: [1, 1.1],
    });

    const options = state.charts.at(-1)?.options ?? {};
    const xAxis = options.xAxis as {
      tickFormatter: (value: number) => string | null;
    };
    const yAxis = options.yAxis as {
      tickFormatter: (value: number) => string | null;
    };
    expect(xAxis.tickFormatter(0.1)).toBe("323.100");
    expect(yAxis.tickFormatter(1.04)).toBe("1.040");

    host.setRangesOnly({ min: 323, max: 333 }, [1, 10]);
    expect(xAxis.tickFormatter(0.1)).toBe("323.1");
  });

  it("restores opacity when emphasis clears on an unchanged response", async () => {
    const host = await hostFixture();
    const data = response(["signal-1", "signal-2"]);
    const styles = [stroke(0), stroke(1)];
    const opacityOf = (index: number) =>
      (
        (state.charts.at(-1)?.options ?? {}).series as Array<{
          lineStyle: { opacity: number };
        }>
      )[index]?.lineStyle.opacity;

    host.render(request(data, styles, [0]));
    expect(opacityOf(0)).toBeCloseTo(1);
    expect(opacityOf(1)).toBeCloseTo(0.25);

    host.render(request(data, styles, []));
    expect(opacityOf(1)).toBeCloseTo(1);
  });

  it("maps hue to the same palette slot as the plot renderer", async () => {
    const host = await hostFixture();
    const data = response(["signal-1", "signal-2"]);

    host.render(request(data, [stroke(1), stroke(2)]));

    const series = state.charts.at(-1)?.options.series as Array<{
      color: string;
    }>;
    expect(series[0]?.color).toBe(palette.series[0]);
    expect(series[1]?.color).toBe(palette.series[1]);
  });

  it("compensates thin ChartGPU strokes without flattening wider styles", async () => {
    const host = await hostFixture();
    const data = response(["normal", "ghost", "wide", "emphasized"]);
    const styles = [
      { ...stroke(1), width: 1.4 },
      { ...stroke(null), width: 1 },
      { ...stroke(1), width: 2.6 },
      { ...stroke(1), width: 1.4 },
    ];

    host.render(request(data, styles, [3]));

    const series = state.charts.at(-1)?.options.series as Array<{
      lineStyle: { width: number };
    }>;
    expect(series.map(({ lineStyle }) => lineStyle.width)).toEqual([
      3, 4, 5.2, 4.8,
    ]);
    expect(state.charts.at(-1)?.options.performance).toEqual({ lod: "strict" });
  });

  it("scales compensated ChartGPU widths globally", async () => {
    const host = await hostFixture();
    const data = response(["normal", "ghost", "wide", "emphasized"]);
    const styles = [
      { ...stroke(1), width: 1.4 },
      { ...stroke(null), width: 1 },
      { ...stroke(1), width: 2.6 },
      { ...stroke(1), width: 1.4 },
    ];

    host.render({
      ...request(data, styles, [3]),
      palette: { ...palette, lineWidthScale: 1.5 },
    });

    const series = state.charts.at(-1)?.options.series as Array<{
      lineStyle: { width: number };
    }>;
    const widths = series.map(({ lineStyle }) => lineStyle.width);
    [4.5, 6, 7.8, 7.2].forEach((expected, index) => {
      expect(widths[index]).toBeCloseTo(expected);
    });
    expect(state.charts.at(-1)?.options.performance).toEqual({ lod: "strict" });
  });

  it("uses ghost and emphasis styling without changing series identity unnecessarily", async () => {
    const host = await hostFixture();
    const data = response(["signal-1", "signal-2"]);
    const styles = [stroke(null), stroke(1)];

    host.render(request(data, styles, [1]));
    const first = (state.charts.at(-1)?.options.series as unknown[]).slice();
    const firstStyles = first.map(
      (value) =>
        value as {
          color: string;
          lineStyle: { opacity: number; width: number };
        },
    );
    expect(firstStyles[0]?.color).toBe(palette.fg4);
    expect(firstStyles[0]?.lineStyle.opacity).toBe(1);
    expect(firstStyles[1]?.lineStyle.opacity).toBe(1);
    expect(firstStyles[1]?.lineStyle.width).toBe(4.8);

    host.render(request(data, styles, [1]));
    const second = state.charts.at(-1)?.options.series as unknown[];
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
  });

  it("draws colored series after ghost series", async () => {
    const host = await hostFixture();
    const data = response(["focus-1", "ghost-1", "focus-2", "ghost-2"]);

    host.render(
      request(data, [stroke(1), stroke(null), stroke(2), stroke(null)]),
    );

    const series = state.charts.at(-1)?.options.series as Array<{
      name: string;
    }>;
    expect(series.map(({ name }) => name)).toEqual([
      "signal_1",
      "signal_3",
      "signal_0",
      "signal_2",
    ]);
  });

  it("attenuates dense ghost fields without dimming colored foreground", async () => {
    const host = await hostFixture();
    const signalIds = Array.from({ length: 65 }, (_, index) =>
      index === 64 ? "focus" : `ghost-${String(index)}`,
    );
    const styles = signalIds.map((_, index) =>
      index === 64 ? stroke(1) : { ...stroke(null), alpha: 0.5 },
    );

    host.render(request(response(signalIds), styles));

    const series = state.charts.at(-1)?.options.series as Array<{
      name: string;
      lineStyle: { opacity: number };
    }>;
    expect(series[0]?.lineStyle.opacity).toBeCloseTo(0.25);
    expect(series.at(-1)?.name).toBe("signal_64");
    expect(series.at(-1)?.lineStyle.opacity).toBe(1);
  });

  it("updates ranges without rebuilding series and refreshes the text layer", async () => {
    const host = await hostFixture();
    host.render(request());
    const chart = state.charts.at(-1);
    const series = chart?.options.series;
    chart?.setOption.mockClear();

    host.setRangesOnly({ min: 11, max: 12 }, [-1, 5]);

    expect(chart?.setOption).toHaveBeenCalledOnce();
    expect(chart?.options.series).toBe(series);
    expect(chart?.renderFrame).toHaveBeenCalled();
    expect(host.layout()).toEqual({
      plot: { x: 60, y: 8, width: 328, height: 258 },
      xRange: { min: 11, max: 12 },
      yRange: { min: -1, max: 5 },
    });
  });

  it("reuses the resolved series array when only the ranges changed", async () => {
    const host = await hostFixture();
    const data = response(["signal-1"]);
    const seriesOf = () => (state.charts.at(-1)?.options ?? {}).series;

    host.render(request(data));
    const first = seriesOf();

    host.render({ ...request(data), xRange: { min: 11, max: 13 } });

    expect(seriesOf()).toBe(first);
    const xAxis = (state.charts.at(-1)?.options ?? {}).xAxis as { min: number };
    expect(xAxis.min).toBe(1);
  });

  it("rebuilds the options when a label changed", async () => {
    const host = await hostFixture();
    const data = response(["signal-1"]);
    const seriesOf = () => (state.charts.at(-1)?.options ?? {}).series;

    host.render(request(data));
    const first = seriesOf();

    host.render({ ...request(data), yLabel: "amps" });

    expect(seriesOf()).not.toBe(first);
    const yAxis = (state.charts.at(-1)?.options ?? {}).yAxis as {
      name: string;
    };
    expect(yAxis.name).toBe("amps");
  });

  it("restyles series and grid lines when the palette changes", async () => {
    const host = await hostFixture();
    host.render(request());
    const chart = state.charts.at(-1);
    const firstSeries = (chart?.options.series as unknown[])[0];
    const nextPalette = { ...palette, grid: "#404040", series: ["#00ff00"] };

    host.render({ ...request(), palette: nextPalette });

    const options = chart?.options ?? {};
    expect((options.series as unknown[])[0]).not.toBe(firstSeries);
    expect((options.gridLines as { color: string }).color).toBe("#404040");
  });

  it("forces a same-frame render and composites all ChartGPU canvases for capture", async () => {
    const host = await hostFixture();
    host.render(request());
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({
        drawImage: vi.fn(),
      } as unknown as CanvasRenderingContext2D);
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });

    const capture = host.capture();
    callbacks.shift()?.(0);
    const canvas = await capture;

    expect(canvas.width).toBe(320);
    expect(canvas.height).toBe(180);
    expect(state.charts.at(-1)?.renderFrame).toHaveBeenCalled();
    getContext.mockRestore();
  });

  it("unregisters the host and disposes ChartGPU", async () => {
    const host = await hostFixture();
    const chart = state.charts.at(-1);

    host.dispose();

    expect(chart?.dispose).toHaveBeenCalledOnce();
  });
});
