import { describe, expect, it } from "vitest";
import type { EnvelopeBin } from "../generated/protocol";
import {
  binColumnsFromWire,
  type ColumnarTile,
  type ColumnarTileResponse,
} from "../app/bin-columns";
import type { PackedPointStream } from "../app/tile-points";
import {
  CanvasRenderer,
  dashPattern,
  formatTicks,
  gutterWidth,
  ticks,
  type Palette,
  type RenderOptions,
  type SeriesStroke,
} from "./canvas-renderer";

interface DrawCall {
  op: string;
  args: readonly unknown[];
}

function recordingContext(charWidth = 6): {
  calls: DrawCall[];
  context: CanvasRenderingContext2D;
} {
  const calls: DrawCall[] = [];
  const push = (op: string, ...args: unknown[]): void => {
    calls.push({ op, args });
  };
  let fill = "";
  let stroke = "";
  let alpha = 1;
  let lineWidth = 1;
  const context = {
    font: "",
    textAlign: "start",
    textBaseline: "alphabetic",
    imageSmoothingEnabled: true,
    get lineWidth(): number {
      return lineWidth;
    },
    set lineWidth(value: number) {
      lineWidth = value;
      push("=lineWidth", value);
    },
    get globalAlpha(): number {
      return alpha;
    },
    set globalAlpha(value: number) {
      alpha = value;
      push("=globalAlpha", value);
    },
    get fillStyle(): string {
      return fill;
    },
    set fillStyle(value: string) {
      fill = value;
      push("=fillStyle", value);
    },
    get strokeStyle(): string {
      return stroke;
    },
    set strokeStyle(value: string) {
      stroke = value;
      push("=strokeStyle", value);
    },
    beginPath(): void {
      push("beginPath");
    },
    moveTo(x: number, y: number): void {
      push("moveTo", x, y);
    },
    lineTo(x: number, y: number): void {
      push("lineTo", x, y);
    },
    stroke(): void {
      push("stroke");
    },
    fillRect(x: number, y: number, width: number, height: number): void {
      push("fillRect", x, y, width, height);
    },
    fillText(text: string, x: number, y: number): void {
      push("fillText", text, x, y);
    },
    rect(x: number, y: number, width: number, height: number): void {
      push("rect", x, y, width, height);
    },
    clip(): void {
      push("clip");
    },
    setLineDash(segments: number[]): void {
      push("setLineDash", [...segments]);
    },
    setTransform(
      a: number,
      b: number,
      c: number,
      d: number,
      e: number,
      f: number,
    ): void {
      push("setTransform", a, b, c, d, e, f);
    },
    save(): void {
      push("save");
    },
    restore(): void {
      push("restore");
    },
    translate(x: number, y: number): void {
      push("translate", x, y);
    },
    rotate(angle: number): void {
      push("rotate", angle);
    },
    measureText(text: string): TextMetrics {
      return { width: text.length * charWidth } as TextMetrics;
    },
  };
  return { calls, context: context as unknown as CanvasRenderingContext2D };
}

function fakeCanvas(
  width: number,
  height: number,
  context: CanvasRenderingContext2D,
): HTMLCanvasElement {
  return {
    clientWidth: width,
    clientHeight: height,
    width: 0,
    height: 0,
    getContext: () => context,
  } as unknown as HTMLCanvasElement;
}

class RecordingPath2D {
  static calls: DrawCall[] = [];

  moveTo(x: number, y: number): void {
    RecordingPath2D.calls.push({ op: "moveTo", args: [x, y] });
  }

  lineTo(x: number, y: number): void {
    RecordingPath2D.calls.push({ op: "lineTo", args: [x, y] });
  }
}

globalThis.Path2D = RecordingPath2D as unknown as typeof Path2D;

const TEST_PALETTE: Palette = {
  background: "#0e1116",
  border: "#2e3340",
  fg2: "#a9b0bc",
  fg3: "#737985",
  fg4: "#4d5563",
  grid: "#1a1d24",
  series: [
    "#0072bd",
    "#d95319",
    "#edb120",
    "#7e2f8e",
    "#77ac30",
    "#4dbeee",
    "#a2142f",
    "#0072bd",
  ],
  fontPlot: '"JetBrains Mono", monospace',
  fontSize: 9,
};

function tile(
  path: string,
  bins: readonly { t0: number; t1: number; v: number; gap?: boolean }[],
): ColumnarTile {
  const points: PackedPointStream = {
    count: 0,
    bytes: new Uint8Array(),
    forceBreakFirst: false,
  };
  return {
    signalId: path,
    signalPath: path,
    unit: null,
    level: 0,
    sourceStart: "0",
    sourceEnd: String(bins.length),
    origin: 0,
    bins: binColumnsFromWire(
      bins.map(
        (bin): EnvelopeBin => ({
          t0: bin.t0,
          t1: bin.t1,
          first: bin.v,
          last: bin.v,
          min: bin.v,
          max: bin.v,
          sum: bin.v,
          sum_sq: bin.v * bin.v,
          finite_count: "1",
          sample_count: "1",
          has_gap: bin.gap ?? false,
        }),
      ),
    ),
    points,
  };
}

function renderOnce(
  series: ColumnarTile[],
  options: Partial<RenderOptions> = {},
): { calls: DrawCall[]; renderer: CanvasRenderer } {
  const { calls, context } = recordingContext();
  RecordingPath2D.calls = calls;
  const renderer = new CanvasRenderer(fakeCanvas(400, 200, context));
  renderer.setPalette(TEST_PALETTE);
  renderer.render(
    { requestId: "test", series },
    { min: 0, max: 10 },
    {
      xLabel: "time (s)",
      yLabel: "value",
      styles: series.map<SeriesStroke>((_, index) => ({
        hue: index + 1,
        dash: "solid",
        width: 1.4,
        alpha: 1,
      })),
      yRange: [-1, 5],
      ...options,
    },
  );
  return { calls, renderer };
}

function dataCalls(calls: readonly DrawCall[]): readonly DrawCall[] {
  const clip = calls.findIndex((call) => call.op === "clip");
  const restore = calls.findIndex(
    (call, index) => index > clip && call.op === "restore",
  );
  return calls.slice(clip, restore);
}

describe("axis helpers", () => {
  it("produces round ticks and shared formatting", () => {
    expect(ticks(0, 60, 7)).toEqual([0, 10, 20, 30, 40, 50, 60]);
    expect(formatTicks([0, 0.25, 0.5, 0.75, 1])).toEqual([
      "0.00",
      "0.25",
      "0.50",
      "0.75",
      "1.00",
    ]);
    expect(formatTicks([-150, 0, 150])).toEqual(["−150", "0", "150"]);
  });

  it("sizes the y-axis gutter from its labels", () => {
    expect(gutterWidth(["1234"], 6)).toBe(48);
    expect(gutterWidth(["12345"], 6)).toBeGreaterThan(48);
  });

  it("maps stroke classes to canvas dash patterns", () => {
    expect(dashPattern("solid")).toEqual([]);
    expect(dashPattern("dash")).toEqual([6, 4]);
    expect(dashPattern("dot")).toEqual([1.5, 3]);
  });
});

describe("time-series rendering", () => {
  it.each(["gutter", "inline"] as const)(
    "draws %s axis furniture after every series",
    (axisStyle) => {
      const { calls } = renderOnce([tile("a", [{ t0: 0, t1: 1, v: 1 }])], {
        axisStyle,
      });
      const seriesStroke = calls.findIndex(
        (call) => call.op === "strokeStyle" || call.op === "=strokeStyle",
      );
      const firstAxisLabel = calls.findIndex((call) => call.op === "fillText");
      expect(seriesStroke).toBeGreaterThan(-1);
      expect(firstAxisLabel).toBeGreaterThan(seriesStroke);
    },
  );

  it("keeps each response series as its own stroke", () => {
    const { calls } = renderOnce(
      [
        tile("a", [{ t0: 0, t1: 1, v: 1 }]),
        tile("b", [{ t0: 0, t1: 1, v: 2 }]),
        tile("c", [{ t0: 0, t1: 1, v: 3 }]),
      ],
      {
        styles: [
          { hue: 1, dash: "solid", width: 1.4, alpha: 1 },
          { hue: 2, dash: "solid", width: 1.4, alpha: 1 },
          { hue: 3, dash: "solid", width: 1.4, alpha: 1 },
        ],
      },
    );
    expect(
      dataCalls(calls).filter((call) => call.op === "stroke"),
    ).toHaveLength(3);
    expect(calls).toContainEqual({ op: "=strokeStyle", args: ["#0072bd"] });
    expect(calls).toContainEqual({ op: "=strokeStyle", args: ["#d95319"] });
    expect(calls).toContainEqual({ op: "=strokeStyle", args: ["#edb120"] });
  });

  it("emits every bin directly, including dense responses", () => {
    const bins = Array.from({ length: 700 }, (_, index) => ({
      t0: index / 70,
      t1: (index + 1) / 70,
      v: Math.sin(index / 10),
    }));
    const { calls } = renderOnce([tile("dense", bins)]);
    const vertices = dataCalls(calls).filter(
      (call) => call.op === "moveTo" || call.op === "lineTo",
    );
    expect(vertices).toHaveLength(700);
  });

  it("breaks strokes at gap flags", () => {
    const { calls } = renderOnce([
      tile("a", [
        { t0: 0, t1: 1, v: 1 },
        { t0: 1, t1: 2, v: 2 },
        { t0: 2, t1: 3, v: 3, gap: true },
        { t0: 3, t1: 4, v: 4 },
      ]),
    ]);
    expect(dataCalls(calls).filter((call) => call.op === "moveTo").length).toBe(
      3,
    );
  });

  it("does not substitute fills or bands for sparse data", () => {
    const { calls } = renderOnce([tile("a", [{ t0: 0, t1: 1, v: 1 }])]);
    expect(calls.some((call) => call.op === "fill")).toBe(false);
  });

  it("applies hue, dash, and emphasis without changing geometry", () => {
    const first = renderOnce([tile("a", [{ t0: 0, t1: 1, v: 1 }])], {
      styles: [{ hue: 2, dash: "dash", width: 1.2, alpha: 0.6 }],
    });
    const second = renderOnce([tile("a", [{ t0: 0, t1: 1, v: 1 }])], {
      styles: [{ hue: 2, dash: "dash", width: 1.2, alpha: 0.6 }],
      emphasisIndex: 0,
    });
    expect(first.calls).toContainEqual({
      op: "=strokeStyle",
      args: [TEST_PALETTE.series[1]],
    });
    expect(first.calls).toContainEqual({
      op: "setLineDash",
      args: [[6, 4]],
    });
    expect(second.calls).toContainEqual({ op: "=lineWidth", args: [1.6] });
    expect(second.calls).toContainEqual({ op: "=globalAlpha", args: [1] });
  });

  it("records a deterministic linear layout and reuses path geometry", () => {
    const { calls, renderer } = renderOnce([
      tile("a", [{ t0: 0, t1: 1, v: 1 }]),
    ]);
    expect(renderer.lastLayout()).toMatchObject({
      xRange: { min: 0, max: 10 },
      yRange: { min: -1, max: 5 },
    });
    expect(calls.some((call) => call.op === "rect")).toBe(true);

    const { context } = recordingContext();
    const reused = new CanvasRenderer(fakeCanvas(400, 200, context));
    reused.setPalette(TEST_PALETTE);
    const response: ColumnarTileResponse = {
      requestId: "test",
      series: [tile("a", [{ t0: 0, t1: 1, v: 1 }])],
    };
    reused.render(
      response,
      { min: 0, max: 10 },
      {
        xLabel: "t",
        yLabel: "v",
        yRange: [-1, 5],
      },
    );
    const pathCount = RecordingPath2D.calls.length;
    reused.render(
      response,
      { min: 0, max: 10 },
      {
        xLabel: "t",
        yLabel: "v",
        yRange: [-1, 5],
        emphasisIndex: 0,
      },
    );
    expect(RecordingPath2D.calls.length).toBe(pathCount);
  });
});
