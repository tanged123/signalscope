// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { binColumnsFromWire } from "../app/bin-columns";
import type { ColumnarTileResponse } from "../app/bin-columns";
import type { Palette, SeriesStroke } from "./canvas-renderer";
import type { GpuContext } from "./gpu-context";

const state = vi.hoisted(() => ({
  charts: [] as Array<{
    options: Record<string, unknown>;
    setOption: ReturnType<typeof vi.fn>;
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
  sequential: ["#000000", "#ffffff"],
  fontPlot: "JetBrains Mono",
  fontSize: 11,
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
          t1: 12,
          first: index + 1,
          last: index + 2,
          min: index,
          max: index + 3,
          sum: index + 2,
          sum_sq: 0,
          finite_count: "2",
          sample_count: "2",
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
    const series = options.series as Array<{ data: { x: ArrayLike<number> } }>;
    expect(xAxis.min).toBe(0);
    expect(xAxis.max).toBe(2);
    expect(Array.from(series[0]?.data.x ?? [])).toEqual([0, 1, 1, 2]);
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
    expect(firstStyles[1]?.lineStyle.width).toBe(1.9);

    host.render(request(data, styles, [1]));
    const second = state.charts.at(-1)?.options.series as unknown[];
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
  });

  it("updates ranges without rebuilding series and reports the ChartGPU grid layout", async () => {
    const host = await hostFixture();
    host.render(request());
    const chart = state.charts.at(-1);
    const series = chart?.options.series;

    host.setRangesOnly({ min: 11, max: 12 }, [-1, 5]);

    expect(chart?.options.series).toBe(series);
    expect(host.layout()).toEqual({
      plot: { x: 60, y: 8, width: 328, height: 258 },
      xRange: { min: 11, max: 12 },
      yRange: { min: -1, max: 5 },
    });
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
