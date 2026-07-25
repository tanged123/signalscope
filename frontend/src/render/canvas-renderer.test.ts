import { describe, expect, it } from "vitest";
import type { SignalTile, TileResponse } from "../generated/protocol";
import {
  CanvasRenderer,
  dashPattern,
  formatTicks,
  gutterWidth,
  resolveSeriesStyle,
  ticks,
  type Palette,
  type RenderOptions,
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
  const stub = {
    font: "",
    textAlign: "start",
    textBaseline: "alphabetic",
    lineWidth: 1,
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
  grid: "#1a1d24",
  series: [
    "#407fd0",
    "#a7451c",
    "#29ab79",
    "#5e57b2",
    "#a6416b",
    "#28a4b0",
    "#247320",
    "#db6c66",
  ],
  fontMono: '"JetBrains Mono", monospace',
};

function tile(
  path: string,
  bins: readonly { t0: number; t1: number; v: number; gap?: boolean }[],
): SignalTile {
  return {
    signal_path: path,
    unit: null,
    bins: bins.map((bin) => ({
      t0: bin.t0,
      t1: bin.t1,
      first: bin.v,
      last: bin.v,
      min: bin.v,
      max: bin.v,
      count: 1,
      has_gap: bin.gap ?? false,
    })),
  } as unknown as SignalTile;
}

function renderOnce(
  series: SignalTile[],
  options: Partial<RenderOptions> = {},
): DrawCall[] {
  const { calls, context } = recordingContext();
  const renderer = new CanvasRenderer(fakeCanvas(400, 200, context));
  renderer.setPalette(TEST_PALETTE);
  const response = { request_id: "test", series } as TileResponse;
  renderer.render(
    response,
    { min: 0, max: 10 },
    {
      xLabel: "time (s)",
      yLabel: "value",
      colorSlots: series.map((_, index) => index + 1),
      dashes: series.map(() => "solid"),
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
});

describe("gutterWidth", () => {
  it("keeps the default gutter for short labels", () => {
    expect(gutterWidth(formatTicks([0, 100, 300]), 6)).toBe(52);
  });

  it("grows so long labels clear the rotated axis title", () => {
    expect(gutterWidth(formatTicks([0, -120_000]), 6)).toBeGreaterThan(52);
  });
});

describe("resolveSeriesStyle", () => {
  it("bands the dash class by colour slot", () => {
    expect(resolveSeriesStyle(1, "solid").dash).toBe("solid");
    expect(resolveSeriesStyle(8, "solid").dash).toBe("solid");
    expect(resolveSeriesStyle(9, "solid").dash).toBe("dash");
    expect(resolveSeriesStyle(16, "solid").dash).toBe("dash");
    expect(resolveSeriesStyle(17, "solid").dash).toBe("dot");
  });

  it("folds the colour index onto eight slots", () => {
    expect(resolveSeriesStyle(1, "solid").colorIndex).toBe(0);
    expect(resolveSeriesStyle(9, "solid").colorIndex).toBe(0);
    expect(resolveSeriesStyle(10, "solid").colorIndex).toBe(1);
  });

  it("lets an explicit user dash win and handles malformed slots", () => {
    expect(resolveSeriesStyle(9, "dot").dash).toBe("dot");
    expect(resolveSeriesStyle(0, "solid").colorIndex).toBeGreaterThanOrEqual(0);
    expect(resolveSeriesStyle(-3, "solid").colorIndex).toBeGreaterThanOrEqual(
      0,
    );
  });

  it("gives the first 24 slots distinct composite identities", () => {
    const seen = new Set<string>();
    for (let slot = 1; slot <= 24; slot += 1) {
      const style = resolveSeriesStyle(slot, "solid");
      const key = `${String(style.colorIndex)}:${style.dash}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
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
      { colorSlots: [1, 3] },
    );
    const strokes = calls
      .filter((call) => call.op === "=strokeStyle")
      .map((call) => call.args[0]);
    expect(strokes).toContain("#407fd0");
    expect(strokes).toContain("#29ab79");
  });

  it("dashes slot 9 and resets the pattern afterwards", () => {
    const calls = renderOnce(
      [
        tile("a", [{ t0: 0, t1: 1, v: 1 }]),
        tile("b", [{ t0: 0, t1: 1, v: 2 }]),
      ],
      { colorSlots: [1, 9] },
    );
    const patterns = calls
      .filter((call) => call.op === "setLineDash")
      .map((call) => JSON.stringify(call.args[0]));
    expect(patterns).toContain(JSON.stringify([6, 4]));
    expect(patterns.at(-1)).toBe(JSON.stringify([]));
  });

  it("draws the zero datum with spine ink", () => {
    const calls = renderOnce([tile("a", [{ t0: 0, t1: 1, v: 1 }])]);
    const styles = calls
      .filter((call) => call.op === "=strokeStyle")
      .map((call) => call.args[0]);
    expect(styles).toContain(TEST_PALETTE.fg3);
  });
});
