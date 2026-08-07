import { describe, expect, it } from "vitest";
import { AxisRenderer, gutterWidth, ticks } from "./axis-renderer";

describe("AxisRenderer", () => {
  it("keeps ticks and gutter sizing deterministic", () => {
    expect(ticks(0, 10, 6)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(gutterWidth(["0.0", "100.0"], 6)).toBe(54);
  });

  it("publishes a layout before GPU series rendering", () => {
    const context = {
      setTransform: () => undefined,
      fillRect: () => undefined,
      measureText: () => ({ width: 6 }),
      fillText: () => undefined,
      beginPath: () => undefined,
      moveTo: () => undefined,
      lineTo: () => undefined,
      stroke: () => undefined,
      save: () => undefined,
      restore: () => undefined,
      translate: () => undefined,
      rotate: () => undefined,
    } as unknown as CanvasRenderingContext2D;
    const canvas = {
      clientWidth: 400,
      clientHeight: 200,
      width: 0,
      height: 0,
      getContext: () => context,
    } as unknown as HTMLCanvasElement;
    const renderer = new AxisRenderer(canvas);
    renderer.setPalette({
      background: "#000",
      fg2: "#fff",
      fg3: "#aaa",
      grid: "#222",
      fontPlot: "monospace",
      fontSize: 9,
    });
    renderer.render({ min: 0, max: 10 }, { min: -1, max: 1 }, "time", "value");
    expect(renderer.lastLayout()?.plot.width).toBeGreaterThan(0);
  });
});
