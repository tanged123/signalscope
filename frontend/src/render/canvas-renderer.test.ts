import { describe, expect, it } from "vitest";
import {
  CanvasRenderer,
  dashPattern,
  formatTicks,
  gutterWidth,
  ticks,
  type Palette,
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

class TestPath2D {
  moveTo(): void {}

  lineTo(): void {}
}
globalThis.Path2D = TestPath2D as unknown as typeof Path2D;

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

  it("strokes a colour-mapped path once per ramp bucket, not once per segment", () => {
    const { context, calls } = recordingContext();
    const path2D = globalThis as unknown as { Path2D?: typeof Path2D };
    const previousPath2D = path2D.Path2D;
    class RecordingPath2D {
      moveTo(): void {}

      lineTo(): void {}
    }
    path2D.Path2D = RecordingPath2D as unknown as typeof Path2D;
    try {
      const renderer = new CanvasRenderer(fakeCanvas(600, 400, context));
      renderer.setPalette(TEST_PALETTE);

      const vertices = 5000;
      const points: number[] = [];
      const colorValues: number[] = [];
      for (let index = 0; index < vertices; index += 1) {
        points.push(index, Math.sin(index / 50));
        colorValues.push(index / (vertices - 1));
      }

      renderer.renderPaths(
        [{ points, colorValues, hue: 1, dash: "solid", width: 1.2, alpha: 1 }],
        {
          xLabel: "x",
          yLabel: "y",
          xRange: [0, vertices],
          yRange: [-1, 1],
        },
      );

      // 64 ramp steps -> at most 65 buckets, plus the axis furniture's strokes.
      expect(
        calls.filter((call) => call.op === "stroke").length,
      ).toBeLessThanOrEqual(80);
    } finally {
      if (previousPath2D === undefined) delete path2D.Path2D;
      else path2D.Path2D = previousPath2D;
    }
  });

  it("equalises the pixel scale of both axes when equalAspect is set", () => {
    const { context } = recordingContext();
    const renderer = new CanvasRenderer(fakeCanvas(600, 300, context));
    renderer.setPalette(TEST_PALETTE);

    renderer.renderPaths(
      [{ points: [0, 0, 10, 10], hue: 1, dash: "solid", width: 1, alpha: 1 }],
      {
        xLabel: "x",
        yLabel: "y",
        xRange: [0, 10],
        yRange: [0, 10],
        equalAspect: true,
      },
    );

    const layout = renderer.lastLayout();
    expect(layout).not.toBeNull();
    const { plot, xRange, yRange } = layout as NonNullable<
      ReturnType<CanvasRenderer["lastLayout"]>
    >;
    const xScale = plot.width / (xRange.max - xRange.min);
    const yScale = plot.height / (yRange.max - yRange.min);
    expect(xScale).toBeCloseTo(yScale, 6);
    // The wider axis is padded, never narrowed.
    expect(xRange.max - xRange.min).toBeGreaterThanOrEqual(10);
    expect(yRange.max - yRange.min).toBeGreaterThanOrEqual(10);
  });

  it("sizes the gutter from the equalised y range, not the requested one", () => {
    const { context } = recordingContext();
    const renderer = new CanvasRenderer(fakeCanvas(600, 300, context));
    renderer.setPalette(TEST_PALETTE);

    // A very wide, very short trajectory: equalising widens y from a span of
    // 1 to tens of thousands, so its tick labels grow from "0.25" to "-20000".
    renderer.renderPaths(
      [
        {
          points: [0, 0, 100_000, 1],
          hue: 1,
          dash: "solid",
          width: 1,
          alpha: 1,
        },
      ],
      {
        xLabel: "x",
        yLabel: "y",
        xRange: [0, 100_000],
        yRange: [0, 1],
        equalAspect: true,
      },
    );

    const layout = renderer.lastLayout();
    expect(layout).not.toBeNull();
    const { plot, xRange, yRange } = layout as NonNullable<
      ReturnType<CanvasRenderer["lastLayout"]>
    >;
    // The y span really did grow enough to lengthen its labels.
    expect(yRange.max - yRange.min).toBeGreaterThan(1_000);
    // The gutter must fit the labels actually drawn, which come from the
    // equalised range. Sizing it from the requested range clips them.
    expect(plot.x).toBe(
      gutterWidth(formatTicks(ticks(yRange.min, yRange.max, 6)), 6),
    );
    // Re-solving the gutter must leave the axes equal, not just wider.
    expect(plot.width / (xRange.max - xRange.min)).toBeCloseTo(
      plot.height / (yRange.max - yRange.min),
      6,
    );
  });

  it("leaves ranges untouched when equalAspect is absent", () => {
    const { context } = recordingContext();
    const renderer = new CanvasRenderer(fakeCanvas(600, 300, context));
    renderer.setPalette(TEST_PALETTE);
    renderer.renderPaths(
      [{ points: [0, 0, 10, 10], hue: 1, dash: "solid", width: 1, alpha: 1 }],
      { xLabel: "x", yLabel: "y", xRange: [0, 10], yRange: [0, 10] },
    );
    const layout = renderer.lastLayout();
    expect(layout?.xRange).toEqual({ min: 0, max: 10 });
    expect(layout?.yRange).toEqual({ min: 0, max: 10 });
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
});
