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
  fontMono: "monospace",
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
    cursorStyle: "line",
    cursorPoints: [],
    xyMarkers: [],
    box: { x0: 100, y0: 50, x1: 200, y1: 150 },
    annotations: [],
    annotationColorIndices: [],
    annotationSpace: "time",
    annotationPoints: [],
    annotationColorValues: [],
    showDelta: false,
  });
  expect(calls).toContain(`strokeStyle:${palette.amber}`);
  expect(calls).toContain(`fillStyle:${palette.amberFill}`);
  expect(calls).toContain("strokeRect");

  calls.length = 0;
  renderer.draw(layout, {
    cursorT: 30,
    cursorStyle: "dot",
    cursorPoints: [{ value: 25, colorIndex: 0 }],
    xyMarkers: [],
    box: null,
    annotations: [],
    annotationColorIndices: [],
    annotationSpace: "time",
    annotationPoints: [],
    annotationColorValues: [],
    showDelta: false,
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
    cursorStyle: "line",
    cursorPoints: [],
    xyMarkers: [{ x: 30, y: 0 }],
    box: null,
    annotations: [],
    annotationColorIndices: [],
    annotationSpace: "time",
    annotationPoints: [],
    annotationColorValues: [],
    showDelta: false,
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
    cursorStyle: "none",
    cursorPoints: [],
    xyMarkers: [],
    box: null,
    annotations: [
      { id: "a", series_path: "s", time: 10, value: 1, label: "" },
      { id: "b", series_path: "s", time: 20, value: 2, label: "" },
    ],
    annotationColorIndices: [0, 0],
    annotationSpace: "plot",
    annotationPoints: [
      { x: 10, y: 100 },
      { x: 40, y: 150 },
    ],
    annotationColorValues: [10, 14],
    showDelta: true,
  };
  renderer.draw(layout, state);
  expect(calls.join(" ")).toContain("Δx");
  expect(calls.join(" ")).toContain("Δc 4.0000");
});
