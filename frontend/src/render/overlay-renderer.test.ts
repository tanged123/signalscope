import { expect, test } from "vitest";
import type { PlotLayout } from "../app/plot-math";
import {
  OverlayRenderer,
  type OverlayPalette,
  type OverlayState,
} from "./overlay-renderer";

const palette: OverlayPalette = {
  amber: "#ffa226",
  amberFill: "rgba(255,162,38,.16)",
  fg1: "#fff",
  fg2: "#aaa",
  fg3: "#777",
  surface0: "#000",
  surface2: "#111",
  fontPlot: "monospace",
  fontSize: 9,
  series: ["#407fd0"],
};

test("draws the cursor and rubber band with interaction amber", () => {
  const calls: string[] = [];
  const context = new Proxy(
    {
      measureText: (text: string) => ({ width: text.length * 6 }),
    },
    {
      get(target, property) {
        // Proxy traps are typed as `any` by lib.dom even though this target is
        // deliberately limited to the recording stub.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        if (property in target) return Reflect.get(target, property);
        return (...args: unknown[]) => {
          void args;
          calls.push(String(property));
        };
      },
      set(_target, property, value) {
        calls.push(`${String(property)}:${String(value)}`);
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
  const canvas = {
    clientWidth: 640,
    clientHeight: 360,
    width: 0,
    height: 0,
    getContext: () => context,
  } as unknown as HTMLCanvasElement;
  const layout: PlotLayout = {
    plot: { x: 52, y: 8, width: 500, height: 300 },
    xRange: { min: 0, max: 60 },
    yRange: { min: -200, max: 200 },
  };
  const renderer = new OverlayRenderer(canvas);
  renderer.setPalette(palette);
  renderer.draw(layout, {
    cursorT: 30,
    cursorMode: "measure",
    cursorPoints: [],
    xyMarkers: [],
    box: { x0: 100, y0: 50, x1: 200, y1: 150 },
    annotations: [],
    delta: null,
  });
  expect(calls).toContain(`strokeStyle:${palette.amber}`);
  expect(calls).toContain(`fillStyle:${palette.amberFill}`);
  expect(calls).toContain("strokeRect");

  calls.length = 0;
  renderer.draw(layout, {
    cursorT: 30,
    cursorMode: "track",
    cursorPoints: [{ value: 25, colorIndex: 0 }],
    xyMarkers: [],
    box: null,
    annotations: [],
    delta: null,
  });
  expect(calls).toContain("strokeStyle:#407fd0");
  expect(calls).toContain("arc");
});

test("draws XY cursor markers as hollow amber rings", () => {
  const calls: string[] = [];
  const context = new Proxy(
    {
      measureText: (text: string) => ({ width: text.length * 6 }),
    },
    {
      get(target, property) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        if (property in target) return Reflect.get(target, property);
        return (...args: unknown[]) => {
          void args;
          calls.push(String(property));
        };
      },
      set(_target, property, value) {
        calls.push(`${String(property)}:${String(value)}`);
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
  const canvas = {
    clientWidth: 640,
    clientHeight: 360,
    width: 0,
    height: 0,
    getContext: () => context,
  } as unknown as HTMLCanvasElement;
  const layout: PlotLayout = {
    plot: { x: 52, y: 8, width: 500, height: 300 },
    xRange: { min: 0, max: 60 },
    yRange: { min: -200, max: 200 },
  };
  const renderer = new OverlayRenderer(canvas);
  renderer.setPalette(palette);
  renderer.draw(layout, {
    cursorT: null,
    cursorMode: "track",
    cursorPoints: [],
    xyMarkers: [{ x: 30, y: 0 }],
    box: null,
    annotations: [],
    delta: null,
  });
  expect(calls).toContain("arc");
  expect(calls).toContain("lineTo");
  expect(calls).toContain("strokeStyle:#ffa226");
});

test("places annotations at supplied plot points when given them", () => {
  const calls: string[] = [];
  const context = new Proxy(
    {
      measureText: (text: string) => ({ width: text.length * 6 }),
    },
    {
      get(target, property) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        if (property in target) return Reflect.get(target, property);
        return (...args: unknown[]) => {
          calls.push(`${String(property)}:${args.map(String).join(":")}`);
        };
      },
      set(_target, property, value) {
        calls.push(`${String(property)}:${String(value)}`);
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
  const canvas = {
    clientWidth: 640,
    clientHeight: 360,
    width: 0,
    height: 0,
    getContext: () => context,
  } as unknown as HTMLCanvasElement;
  const layout: PlotLayout = {
    plot: { x: 52, y: 8, width: 500, height: 300 },
    xRange: { min: 0, max: 60 },
    yRange: { min: -200, max: 200 },
  };
  const renderer = new OverlayRenderer(canvas);
  renderer.setPalette(palette);
  const state: OverlayState = {
    cursorT: null,
    cursorMode: "none",
    cursorPoints: [],
    xyMarkers: [],
    box: null,
    annotations: [
      {
        x: 10,
        y: 100,
        colorIndex: 0,
        label: "10.0000 · 100.0000",
      },
      {
        x: 40,
        y: 150,
        colorIndex: 0,
        label: "40.0000 · 150.0000",
      },
      {
        x: 30,
        y: 300,
        colorIndex: 0,
        label: "outside",
      },
    ],
    delta: {
      label: "Δx 30.0000 · Δy 50.0000 · Δc 4.0000",
      first: { x: 10, y: 100 },
      second: { x: 40, y: 150 },
    },
  };
  renderer.draw(layout, state);
  expect(calls.filter((call) => call.startsWith("arc:"))).toHaveLength(2);
  expect(calls.join(" ")).toContain("Δx");
  expect(calls.join(" ")).toContain("Δc 4.0000");
});

test("clips overlay furniture and keeps edge labels inside the plot", () => {
  const calls: { op: string; args: number[] }[] = [];
  const context = new Proxy(
    {
      measureText: (text: string) => ({ width: text.length * 6 }),
    },
    {
      get(target, property) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        if (property in target) return Reflect.get(target, property);
        return (...args: unknown[]) => {
          calls.push({
            op: String(property),
            args: args.filter((arg): arg is number => typeof arg === "number"),
          });
        };
      },
      set() {
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
  const canvas = {
    clientWidth: 640,
    clientHeight: 360,
    width: 0,
    height: 0,
    getContext: () => context,
  } as unknown as HTMLCanvasElement;
  const layout: PlotLayout = {
    plot: { x: 52, y: 8, width: 500, height: 300 },
    xRange: { min: 0, max: 60 },
    yRange: { min: -200, max: 200 },
  };
  const renderer = new OverlayRenderer(canvas);
  renderer.setPalette(palette);
  renderer.draw(layout, {
    cursorT: null,
    cursorMode: "none",
    cursorPoints: [],
    xyMarkers: [],
    box: { x0: 20, y0: -10, x1: 700, y1: 400 },
    annotations: [
      {
        x: 59,
        y: 195,
        colorIndex: 0,
        label: "edge annotation",
      },
    ],
    delta: {
      label: "Δx 80.0000",
      first: { x: -10, y: 300 },
      second: { x: 70, y: -300 },
    },
  });

  expect(calls).toContainEqual({
    op: "rect",
    args: [52, 8, 500, 300],
  });
  expect(calls.some((call) => call.op === "clip")).toBe(true);
  for (const call of calls.filter((entry) => entry.op === "fillRect")) {
    const [x = 0, y = 0, width = 0, height = 0] = call.args;
    expect(x).toBeGreaterThanOrEqual(layout.plot.x);
    expect(y).toBeGreaterThanOrEqual(layout.plot.y);
    expect(x + width).toBeLessThanOrEqual(layout.plot.x + layout.plot.width);
    expect(y + height).toBeLessThanOrEqual(layout.plot.y + layout.plot.height);
  }
});

test("truncates badge text that cannot fit the plot and keeps plates inside", () => {
  const plates: number[][] = [];
  const texts: string[] = [];
  const context = new Proxy(
    {
      measureText: (text: string) => ({ width: text.length * 6 }),
    },
    {
      get(target, property) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        if (property in target) return Reflect.get(target, property);
        return (...args: unknown[]) => {
          if (property === "fillRect") {
            plates.push(
              args.filter((arg): arg is number => typeof arg === "number"),
            );
          }
          if (property === "fillText" && typeof args[0] === "string") {
            texts.push(args[0]);
          }
        };
      },
      set() {
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
  const canvas = {
    clientWidth: 200,
    clientHeight: 120,
    width: 0,
    height: 0,
    getContext: () => context,
  } as unknown as HTMLCanvasElement;
  // A plot only 90px wide fits 15 glyphs at the stub's 6px advance, so both
  // badges have to clip rather than paint past the right edge.
  const layout: PlotLayout = {
    plot: { x: 10, y: 6, width: 90, height: 60 },
    xRange: { min: 0, max: 60 },
    yRange: { min: -200, max: 200 },
  };
  const renderer = new OverlayRenderer(canvas);
  renderer.setPalette(palette);
  renderer.draw(layout, {
    cursorT: null,
    cursorMode: "none",
    cursorPoints: [],
    xyMarkers: [],
    box: null,
    annotations: [
      {
        x: 55,
        y: 190,
        colorIndex: 0,
        label: "a very long annotation label that will never fit",
      },
    ],
    delta: {
      label: "Δx 30.0000 · Δy 50.0000 · Δc 4.0000",
      first: { x: 10, y: 100 },
      second: { x: 40, y: 150 },
    },
  });

  expect(texts).toHaveLength(2);
  for (const text of texts) {
    expect(text.endsWith("…")).toBe(true);
    expect(text.length * 6).toBeLessThanOrEqual(layout.plot.width);
  }
  expect(plates.length).toBeGreaterThan(0);
  for (const [x = 0, y = 0, width = 0, height = 0] of plates) {
    expect(x).toBeGreaterThanOrEqual(layout.plot.x);
    expect(y).toBeGreaterThanOrEqual(layout.plot.y);
    expect(x + width).toBeLessThanOrEqual(layout.plot.x + layout.plot.width);
    expect(y + height).toBeLessThanOrEqual(layout.plot.y + layout.plot.height);
  }
});
