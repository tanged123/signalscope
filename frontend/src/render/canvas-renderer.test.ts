import { describe, expect, it } from "vitest";
import type { EnvelopeBin } from "../generated/protocol";
import {
  binColumnsFromWire,
  type ColumnarTile,
  type ColumnarTileResponse,
} from "../app/bin-columns";
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
  const stub = {
    font: "",
    textAlign: "start",
    textBaseline: "alphabetic",
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
    strokeRect(x: number, y: number, width: number, height: number): void {
      push("strokeRect", x, y, width, height);
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
    createLinearGradient(
      x0: number,
      y0: number,
      x1: number,
      y1: number,
    ): CanvasGradient {
      push("createLinearGradient", x0, y0, x1, y1);
      return {
        addColorStop(offset: number, color: string): void {
          push("addColorStop", offset, color);
        },
      } as unknown as CanvasGradient;
    },
  };
  return { calls, context: stub as unknown as CanvasRenderingContext2D };
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
  sequential: ["#000000", "#ffffff"],
  fontPlot: '"JetBrains Mono", monospace',
  fontSize: 9,
};

function tile(
  path: string,
  bins: readonly { t0: number; t1: number; v: number; gap?: boolean }[],
): ColumnarTile {
  return {
    signalId: "1",
    signalPath: path,
    unit: null,
    level: 0,
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
  };
}

function renderOnce(
  series: ColumnarTile[],
  options: Partial<RenderOptions> = {},
): DrawCall[] {
  const { calls, context } = recordingContext();
  const renderer = new CanvasRenderer(fakeCanvas(400, 200, context));
  renderer.setPalette(TEST_PALETTE);
  const response: ColumnarTileResponse = { requestId: "test", series };
  renderer.render(
    response,
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
  return calls;
}

describe("ticks", () => {
  it("produces round steps covering the range", () => {
    expect(ticks(0, 60, 7)).toEqual([0, 10, 20, 30, 40, 50, 60]);
  });

  it("snaps zero exactly", () => {
    expect(ticks(-100, 300, 6)).toContain(0);
  });

  it("yields no ticks for unusable ranges", () => {
    expect(ticks(5, 5, 6)).toEqual([]);
    expect(ticks(Number.NaN, Number.NaN, 6)).toEqual([]);
  });
});

describe("formatTicks", () => {
  it("uses one precision for the whole axis", () => {
    expect(formatTicks([0, 10, 20, 30, 40, 50])).toEqual([
      "0",
      "10",
      "20",
      "30",
      "40",
      "50",
    ]);
  });

  it("keeps enough precision to separate close ticks", () => {
    expect(formatTicks([0, 0.25, 0.5, 0.75, 1])).toEqual([
      "0.00",
      "0.25",
      "0.50",
      "0.75",
      "1.00",
    ]);
  });

  it("switches the whole axis to exponential together", () => {
    expect(formatTicks([0, 50_000, 100_000])).toEqual([
      "0.0e+0",
      "5.0e+4",
      "1.0e+5",
    ]);
    expect(formatTicks([0, 0.0005])).toEqual(["0.0e+0", "5.0e-4"]);
  });

  it("returns nothing for an empty axis", () => {
    expect(formatTicks([])).toEqual([]);
  });

  it("uses the typographic minus for negative ticks", () => {
    expect(formatTicks([-150, 0, 150])).toEqual(["−150", "0", "150"]);
  });
});

describe("gutterWidth", () => {
  it("keeps the default gutter for short labels", () => {
    expect(gutterWidth(formatTicks([0, 100, 300]), 6)).toBe(48);
  });

  it("grows so long labels clear the rotated axis title", () => {
    expect(gutterWidth(formatTicks([0, -120_000]), 6)).toBeGreaterThan(52);
  });

  it("tightens four-character labels while retaining five-character clearance", () => {
    const four = gutterWidth(["1234"], 6);
    const five = gutterWidth(["12345"], 6);
    expect(five).toBeGreaterThan(four);
    expect(five).toBeGreaterThanOrEqual(5 * 6 + 24);
  });
});

describe("dashPattern", () => {
  it("maps each class to a distinct canvas pattern", () => {
    expect(dashPattern("solid")).toEqual([]);
    expect(dashPattern("dash")).toEqual([6, 4]);
    expect(dashPattern("dot")).toEqual([1.5, 3]);
  });
});

describe("render", () => {
  it.each(["gutter", "inline"] as const)(
    "paints %s axis furniture after the series stroke",
    (axisStyle) => {
      const calls = renderOnce([tile("a", [{ t0: 0, t1: 1, v: 1 }])], {
        axisStyle,
      });
      const seriesStyle = calls.findIndex(
        (call) =>
          call.op === "=strokeStyle" && call.args[0] === TEST_PALETTE.series[0],
      );
      const seriesStroke = calls.findIndex(
        (call, index) => index > seriesStyle && call.op === "stroke",
      );
      const firstAxisLabel = calls.findIndex((call) => call.op === "fillText");

      expect(seriesStyle).toBeGreaterThan(-1);
      expect(seriesStroke).toBeGreaterThan(seriesStyle);
      expect(firstAxisLabel).toBeGreaterThan(seriesStroke);
    },
  );

  it("reserves a colorbar gutter and strokes per-segment colours", () => {
    const { context, calls } = recordingContext();
    const renderer = new CanvasRenderer(fakeCanvas(600, 300, context));
    renderer.setPalette(TEST_PALETTE);
    renderer.renderPaths(
      [
        {
          points: [0, 0, 1, 1, 2, 2],
          colorValues: [0, 0.5, 1],
          hue: 1,
          dash: "solid",
          width: 1.4,
          alpha: 1,
        },
      ],
      {
        xLabel: "x",
        yLabel: "y",
        xRange: [0, 2],
        yRange: [0, 2],
        colorbar: { min: 0, max: 1, label: "t (s)" },
      },
    );
    const layout = renderer.lastLayout();
    // Spec F2: 64px right gutter holds the 12px bar, ticks, and labels.
    expect((layout?.plot.x ?? 0) + (layout?.plot.width ?? 0)).toBeLessThan(
      600 - 60,
    );
    // One stroke per segment rather than one stroke for the path.
    expect(calls.filter((call) => call.op === "stroke").length).toBeGreaterThan(
      2,
    );
  });

  it("keeps the colorbar visible with inline axes", () => {
    const { context, calls } = recordingContext();
    const renderer = new CanvasRenderer(fakeCanvas(600, 300, context));
    renderer.setPalette(TEST_PALETTE);
    renderer.renderPaths(
      [
        {
          points: [0, 0, 1, 1],
          colorValues: [0.5, 0.5],
          hue: 1,
          dash: "solid",
          width: 1.4,
          alpha: 1,
        },
      ],
      {
        xLabel: "x",
        yLabel: "y",
        xRange: [0, 1],
        yRange: [0, 1],
        axisStyle: "inline",
        colorbar: { min: 4, max: 6, label: "constant" },
      },
    );
    expect(renderer.lastLayout()?.plot).toEqual({
      x: 0,
      y: 0,
      width: 600 - 64,
      height: 300,
    });
    expect(calls.some((call) => call.op === "strokeRect")).toBe(true);
    const xLabel = calls.find(
      (call) => call.op === "fillText" && call.args[0] === "x",
    );
    const colorbarLabel = calls.find(
      (call) => call.op === "fillText" && call.args[0] === "constant",
    );
    expect(xLabel?.args.slice(1)).not.toEqual(colorbarLabel?.args.slice(1));
    expect(
      calls.some(
        (call) => call.op === "rotate" && call.args[0] === -Math.PI / 2,
      ),
    ).toBe(true);
  });

  it("formats colorbar ticks with the shared axis formatter", () => {
    const { context, calls } = recordingContext();
    const renderer = new CanvasRenderer(fakeCanvas(600, 300, context));
    renderer.setPalette(TEST_PALETTE);
    renderer.renderPaths([], {
      xLabel: "x",
      yLabel: "y",
      xRange: [0, 1],
      yRange: [0, 1],
      colorbar: { min: 0.0001, max: 0.0003, label: "magnitude" },
    });

    const labels = calls
      .filter((call) => call.op === "fillText" && call.args[1] === 598)
      .map((call) => call.args[0]);
    expect(labels).toEqual(formatTicks([0.0003, 0.0002, 0.0001]));
  });

  it("renders vertex paths against an explicit x range", () => {
    const { context, calls } = recordingContext();
    const renderer = new CanvasRenderer(fakeCanvas(600, 300, context));
    renderer.setPalette(TEST_PALETTE);
    const elapsed = renderer.renderPaths(
      [
        {
          points: [0, 0, 1, 1, Number.NaN, Number.NaN, 2, 2],
          hue: 1,
          dash: "solid",
          width: 1.4,
          alpha: 1,
        },
      ],
      {
        xLabel: "pos_east (m)",
        yLabel: "pos_north (m)",
        xRange: [0, 2],
        yRange: [0, 2],
      },
    );
    expect(elapsed).toBeGreaterThanOrEqual(0);
    // The NaN vertex lifts the pen: two moveTo calls, not one.
    expect(calls.filter((call) => call.op === "moveTo").length).toBeGreaterThan(
      1,
    );
    expect(renderer.lastLayout()?.xRange).toEqual({ min: 0, max: 2 });
  });

  it("renders ghost paths neutrally even when color values are present", () => {
    const { context, calls } = recordingContext();
    const renderer = new CanvasRenderer(fakeCanvas(600, 300, context));
    renderer.setPalette(TEST_PALETTE);

    renderer.renderPaths(
      [
        {
          points: [0, 0, 1, 1, 2, 2],
          colorValues: [0, 0.5, 1],
          hue: null,
          dash: "solid",
          width: 1,
          alpha: 0.5,
        },
      ],
      {
        xLabel: "x",
        yLabel: "y",
        xRange: [0, 2],
        yRange: [0, 2],
      },
    );

    expect(calls).toContainEqual({
      op: "=strokeStyle",
      args: [TEST_PALETTE.fg4],
    });
    expect(calls).toContainEqual({ op: "=globalAlpha", args: [0.5] });
    expect(calls).not.toContainEqual({
      op: "=strokeStyle",
      args: ["#404040"],
    });
    expect(calls).not.toContainEqual({
      op: "=strokeStyle",
      args: ["#bfbfbf"],
    });
  });

  it("records the plot layout and supports inline axes", () => {
    const { context } = recordingContext();
    const renderer = new CanvasRenderer(fakeCanvas(640, 360, context));
    renderer.setPalette(TEST_PALETTE);
    expect(renderer.lastLayout()).toBeNull();
    renderer.render(
      { requestId: "test", series: [] },
      { min: 0, max: 10 },
      {
        xLabel: "time (s)",
        yLabel: "value",
        styles: [],
        yRange: [1, 5],
        axisStyle: "inline",
      },
    );
    expect(renderer.lastLayout()).toEqual({
      plot: { x: 0, y: 0, width: 640, height: 360 },
      xRange: { min: 0, max: 10 },
      yRange: { min: 1, max: 5 },
      xScale: "linear",
    });
  });

  it("breaks the stroke at gaps", () => {
    const calls = renderOnce([
      tile("a", [
        { t0: 0, t1: 1, v: 1 },
        { t0: 1, t1: 2, v: 2 },
        { t0: 2, t1: 3, v: 3, gap: true },
        { t0: 3, t1: 4, v: 4 },
      ]),
    ]);
    const path = calls.filter(
      (call) => call.op === "moveTo" || call.op === "lineTo",
    );
    expect(path.filter((call) => call.op === "moveTo").length).toBeGreaterThan(
      1,
    );
  });

  it("paints each series in its slot colour", () => {
    const calls = renderOnce(
      [
        tile("a", [{ t0: 0, t1: 1, v: 1 }]),
        tile("b", [{ t0: 0, t1: 1, v: 2 }]),
      ],
      {
        styles: [
          { hue: 1, dash: "solid", width: 1.4, alpha: 1 },
          { hue: 3, dash: "solid", width: 1.4, alpha: 1 },
        ],
      },
    );
    const strokes = calls
      .filter((call) => call.op === "=strokeStyle")
      .map((call) => call.args[0]);
    expect(strokes).toContain("#0072bd");
    expect(strokes).toContain("#edb120");
  });

  it("draws a ghost with the fixed neutral stroke", () => {
    const calls = renderOnce([tile("a", [{ t0: 0, t1: 1, v: 1 }])], {
      styles: [{ hue: null, dash: "solid", width: 1.3, alpha: 0.5 }],
    });
    expect(
      calls.filter(
        (call) =>
          call.op === "=strokeStyle" && call.args[0] === TEST_PALETTE.fg4,
      ),
    ).toHaveLength(1);
    expect(calls).toContainEqual({ op: "=lineWidth", args: [1.3] });
    expect(calls).toContainEqual({ op: "=globalAlpha", args: [0.5] });
    expect(calls).toContainEqual({ op: "setLineDash", args: [[]] });
  });

  it("applies explicit hue tokens and emphasis alpha math", () => {
    const calls = renderOnce(
      [
        tile("a", [{ t0: 0, t1: 1, v: 1 }]),
        tile("b", [{ t0: 0, t1: 1, v: 2 }]),
        tile("c", [{ t0: 0, t1: 1, v: 3 }]),
      ],
      {
        styles: [
          { hue: 2, dash: "solid", width: 1.2, alpha: 0.6 },
          { hue: 5, dash: "dot", width: 1.4, alpha: 0.8 },
          { hue: null, dash: "solid", width: 1, alpha: 0.5 },
        ],
        emphasisIndex: 0,
      },
    );
    const strokes = calls
      .filter((call) => call.op === "=strokeStyle")
      .map((call) => call.args[0]);
    expect(strokes).toContain(TEST_PALETTE.series[1]);
    expect(strokes).toContain(TEST_PALETTE.series[4]);
    expect(strokes).toContain(TEST_PALETTE.fg4);
    expect(calls).toContainEqual({ op: "=globalAlpha", args: [1] });
    expect(calls).toContainEqual({ op: "=globalAlpha", args: [0.25] });
    expect(calls).toContainEqual({ op: "=globalAlpha", args: [0.5] });
    expect(calls).toContainEqual({ op: "=lineWidth", args: [1.6] });
  });

  it("multiplies a dimmed path's configured alpha", () => {
    const { context, calls } = recordingContext();
    const renderer = new CanvasRenderer(fakeCanvas(600, 300, context));
    renderer.setPalette(TEST_PALETTE);

    renderer.renderPaths(
      [
        {
          points: [0, 0, 1, 1],
          hue: 1,
          dash: "solid",
          width: 1.4,
          alpha: 0.8,
          dimmed: true,
        },
      ],
      { xLabel: "x", yLabel: "y", xRange: [0, 1], yRange: [0, 1] },
    );

    expect(calls).toContainEqual({ op: "=globalAlpha", args: [0.4] });
  });

  it("keeps manual dash independent from hue", () => {
    const calls = renderOnce(
      [
        tile("a", [{ t0: 0, t1: 1, v: 1 }]),
        tile("b", [{ t0: 0, t1: 1, v: 2 }]),
      ],
      {
        styles: [
          { hue: 1, dash: "solid", width: 1.4, alpha: 1 },
          { hue: 1, dash: "dash", width: 1.4, alpha: 1 },
        ],
      },
    );
    const patterns = calls
      .filter((call) => call.op === "setLineDash")
      .map((call) => JSON.stringify(call.args[0]));
    expect(patterns).toContain(JSON.stringify([6, 4]));
    expect(patterns.at(-1)).toBe(JSON.stringify([6, 4]));
  });

  it("clips series strokes to the plot rectangle", () => {
    const calls = renderOnce([tile("a", [{ t0: 0, t1: 1, v: 1 }])]);
    expect(calls.some((call) => call.op === "rect")).toBe(true);
    expect(calls.some((call) => call.op === "clip")).toBe(true);
  });
});
