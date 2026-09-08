// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { Colorbar } from "./colorbar";
import type { Palette } from "./plot-theme";
import { compileContour } from "../app/palettes";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

test("display and PNG capture use the selected contour and repaint when it changes", () => {
  const painted: string[] = [];
  const context = {
    fillStyle: "",
    fillRect: (_x: number, y: number) => {
      if (y === 23) painted.push(context.fillStyle);
    },
    strokeRect: vi.fn(),
    fillText: vi.fn(),
    scale: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  const plot = document.createElement("div");
  Object.defineProperty(plot, "clientWidth", { value: 300 });
  const bar = new Colorbar(plot);
  const palette = {
    background: "#000000",
    border: "#333333",
    fg2: "#cccccc",
    fg3: "#aaaaaa",
    fg4: "#888888",
    fontPlot: "monospace",
    contour: compileContour([
      { position: 0, color: "#ff0000" },
      { position: 1, color: "#0000ff" },
    ]),
  } as Palette;
  bar.render({ label: "C", range: [0, 10] }, palette, 0);
  expect(painted[0]).toBe("rgb(255,0,0)");
  expect(painted.at(-1)).toBe("rgb(0,0,255)");
  const output = document.createElement("canvas");
  output.width = 300;
  output.height = 200;
  painted.length = 0;
  bar.capture(output, 0);
  expect(painted[0]).toBe("rgb(255,0,0)");
  expect(painted.at(-1)).toBe("rgb(0,0,255)");
  painted.length = 0;
  bar.render(
    { label: "C", range: [0, 10] },
    {
      ...palette,
      contour: compileContour([
        { position: 0, color: "#000000" },
        { position: 1, color: "#ffffff" },
      ]),
    },
    0,
  );
  expect(painted[0]).toBe("rgb(0,0,0)");
  expect(painted.at(-1)).toBe("rgb(255,255,255)");
  bar.dispose();
});

test("one scale moves between legend and inset, retains pixels across unchanged renders, and exports outside its mount", () => {
  const context = {
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    fillText: vi.fn(),
    scale: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  vi.stubGlobal("devicePixelRatio", 2);
  const plot = document.createElement("div");
  const legend = document.createElement("button");
  Object.defineProperty(plot, "clientWidth", { value: 600 });
  Object.defineProperty(legend, "clientWidth", { value: 180 });
  document.body.append(plot, legend);
  const palette = {
    background: "#111111",
    border: "#333333",
    fg2: "#dddddd",
    fg3: "#aaaaaa",
    fg4: "#666666",
    fontPlot: "monospace",
  } as Palette;
  const scale = { label: "temperature (K)", range: [10, 20] as const };
  const bar = new Colorbar(plot);
  bar.render(scale, palette, 34);
  expect(bar.canvas.dataset.placement).toBe("plot");
  bar.attach(legend);
  bar.render(scale, palette, 34);
  expect(legend.firstChild).toBe(bar.canvas);
  expect(bar.canvas.width).toBe(360);
  expect(bar.canvas.style.width).toBe("180px");
  const calls = context.fillRect.mock.calls.length;
  bar.render(scale, palette, 34);
  expect(context.fillRect).toHaveBeenCalledTimes(calls);
  expect(bar.canvas.style.width).toBe("180px");
  const output = document.createElement("canvas");
  output.width = 1200;
  output.height = 800;
  bar.capture(output, 34);
  expect(output.width).toBe(1200);
  expect(context.fillText).toHaveBeenCalledWith("temperature (K)", 8, 11, 204);
  expect(legend.firstChild).toBe(bar.canvas);
  bar.render({ ...scale, range: [7, 7] }, palette, 34);
  expect(bar.canvas.getAttribute("aria-label")).toContain("7 to 7");
  bar.render({ ...scale, range: null }, palette, 34);
  expect(context.fillText).toHaveBeenCalledWith(
    "no finite color data",
    8,
    43,
    164,
  );
  bar.attach(null);
  bar.render(scale, palette, 34);
  expect(plot.firstChild).toBe(bar.canvas);
  expect(legend.childElementCount).toBe(0);
  bar.render(undefined, palette, 34);
  expect(bar.canvas.hidden).toBe(true);
  bar.dispose();
  expect(plot.childElementCount).toBe(0);
});
