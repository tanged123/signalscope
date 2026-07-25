import { expect, test } from "vitest";
import type { PlotLayout } from "../app/plot-math";
import { OverlayRenderer, type OverlayPalette } from "./overlay-renderer";

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
    box: { x0: 100, y0: 50, x1: 200, y1: 150 },
    annotations: [],
    annotationColorIndices: [],
    showDelta: false,
  });
  expect(calls).toContain(`strokeStyle:${palette.amber}`);
  expect(calls).toContain(`fillStyle:${palette.amberFill}`);
  expect(calls).toContain("strokeRect");
});
