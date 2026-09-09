// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { TIME_POLICY } from "../app/plot-capabilities";
import type { PlotLayout } from "../app/plot-math";
import {
  PlotInteractionController,
  type PlotInteractionHost,
} from "./plot-interactions";

const layout: PlotLayout = {
  plot: { x: 0, y: 0, width: 100, height: 100 },
  xRange: { min: 0, max: 10 },
  yRange: { min: -5, max: 5 },
};

function pointer(
  target: HTMLElement,
  type: "pointerdown" | "pointermove" | "pointerup",
  x: number,
  y: number,
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    button: 0,
    clientX: x,
    clientY: y,
  });
  Object.defineProperties(event, {
    offsetX: { value: x },
    offsetY: { value: y },
    pointerId: { value: 1 },
  });
  target.dispatchEvent(event);
}

function doubleClick(target: HTMLElement, x: number, y: number): void {
  const event = new MouseEvent("dblclick", {
    bubbles: true,
    button: 0,
    clientX: x,
    clientY: y,
  });
  Object.defineProperties(event, {
    offsetX: { value: x },
    offsetY: { value: y },
  });
  target.dispatchEvent(event);
}

function fixture(view: PlotLayout = layout): {
  overlay: HTMLCanvasElement;
  calls: {
    applyXRange: ReturnType<typeof vi.fn>;
    applyYRange: ReturnType<typeof vi.fn>;
    applyRanges: ReturnType<typeof vi.fn>;
    fitView: ReturnType<typeof vi.fn>;
    setGesture: ReturnType<typeof vi.fn>;
    setBox: ReturnType<typeof vi.fn>;
    beginAxisEdit: ReturnType<typeof vi.fn>;
  };
} {
  const overlay = document.createElement("canvas");
  overlay.setPointerCapture = vi.fn();
  const calls = {
    applyXRange: vi.fn(),
    applyYRange: vi.fn(),
    applyRanges: vi.fn(),
    fitView: vi.fn(),
    setGesture: vi.fn(),
    setBox: vi.fn(),
    beginAxisEdit: vi.fn(),
  };
  const host: PlotInteractionHost = {
    layout: vi.fn(() => view),
    applyXRange: calls.applyXRange,
    applyYRange: calls.applyYRange,
    applyRanges: calls.applyRanges,
    fitView: calls.fitView,
    plotClick: vi.fn(),
    setGesture: calls.setGesture,
    setBox: calls.setBox,
    axisEditZone: vi.fn(() => null),
    beginAxisEdit: calls.beginAxisEdit,
  };
  const controller = new PlotInteractionController(overlay, host);
  controller.setPolicy(TIME_POLICY);
  return { overlay, calls };
}

describe("PlotInteractionController", () => {
  it("wheel zooms log Y around its geometric midpoint", () => {
    vi.useFakeTimers();
    const { overlay, calls } = fixture({
      ...layout,
      yScale: "log",
      yRange: { min: 1, max: 10000 },
    });
    const event = new WheelEvent("wheel", {
      deltaY: Math.log(0.5) / 0.0016,
      shiftKey: true,
    });
    Object.defineProperties(event, {
      offsetX: { value: 50 },
      offsetY: { value: 50 },
    });
    overlay.dispatchEvent(event);
    expect(calls.applyYRange).toHaveBeenCalledExactlyOnceWith(10, 1000);
    expect(calls.applyXRange).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
  it.each([false, true])(
    "zooms both equal axes with shift=%s around the pointer",
    (shiftKey) => {
      vi.useFakeTimers();
      const { overlay, calls } = fixture({ ...layout, axisEqual: true });
      const event = new WheelEvent("wheel", { deltaY: -100, shiftKey });
      Object.defineProperties(event, {
        offsetX: { value: 50 },
        offsetY: { value: 50 },
      });
      overlay.dispatchEvent(event);
      expect(calls.applyRanges).toHaveBeenCalledOnce();
      expect(calls.applyXRange).not.toHaveBeenCalled();
      expect(calls.applyYRange).not.toHaveBeenCalled();
      const [x, y] = calls.applyRanges.mock.calls[0] as [
        PlotLayout["xRange"],
        PlotLayout["yRange"],
      ];
      expect(x.max - x.min).toBeLessThan(10);
      expect(x.max - x.min).toBeCloseTo(y.max - y.min);
      expect((x.min + x.max) / 2).toBe(5);
      expect((y.min + y.max) / 2).toBe(0);
      vi.runAllTimers();
      vi.useRealTimers();
    },
  );

  it("zooms both equal axes during an axis-constrained box drag", () => {
    const { overlay, calls } = fixture({ ...layout, axisEqual: true });
    pointer(overlay, "pointerdown", 20, 50);
    pointer(overlay, "pointermove", 80, 52);
    pointer(overlay, "pointerup", 80, 52);
    expect(calls.applyRanges).toHaveBeenCalledExactlyOnceWith(
      { min: 2, max: 8 },
      { min: -3, max: 3 },
    );
    expect(calls.applyXRange).not.toHaveBeenCalled();
    expect(calls.applyYRange).not.toHaveBeenCalled();
  });

  it("publishes a two-axis box in one equal-axis update", () => {
    const { overlay, calls } = fixture({ ...layout, axisEqual: true });
    pointer(overlay, "pointerdown", 20, 30);
    pointer(overlay, "pointermove", 70, 60);
    pointer(overlay, "pointerup", 70, 60);
    expect(calls.applyRanges).toHaveBeenCalledExactlyOnceWith(
      { min: 2, max: 7 },
      { min: -1, max: 2 },
    );
    expect(calls.applyXRange).not.toHaveBeenCalled();
    expect(calls.applyYRange).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "keeps independent wheel zoom with shift=%s",
    (shiftKey) => {
      vi.useFakeTimers();
      const { overlay, calls } = fixture();
      overlay.dispatchEvent(
        new WheelEvent("wheel", { deltaY: -100, shiftKey }),
      );
      expect(calls.applyRanges).not.toHaveBeenCalled();
      expect(calls.applyXRange).toHaveBeenCalledTimes(shiftKey ? 0 : 1);
      expect(calls.applyYRange).toHaveBeenCalledOnce();
      vi.runAllTimers();
      vi.useRealTimers();
    },
  );

  beforeEach(() => vi.restoreAllMocks());

  it("locks horizontal drags to X and applies the selected range", () => {
    const { overlay, calls } = fixture();

    pointer(overlay, "pointerdown", 20, 50);
    pointer(overlay, "pointermove", 80, 52);

    expect(calls.setGesture).toHaveBeenLastCalledWith("drag: zoom X");
    expect(calls.setBox).toHaveBeenLastCalledWith({
      x0: 20,
      y0: 0,
      x1: 80,
      y1: 100,
    });

    pointer(overlay, "pointerup", 80, 52);

    expect(calls.applyXRange).toHaveBeenCalledWith(2, 8);
    expect(calls.applyYRange).not.toHaveBeenCalled();
    expect(calls.setGesture).toHaveBeenLastCalledWith(null);
    expect(calls.setBox).toHaveBeenLastCalledWith(null);
  });

  it("locks vertical drags to Y without changing X", () => {
    const { overlay, calls } = fixture();

    pointer(overlay, "pointerdown", 50, 20);
    pointer(overlay, "pointermove", 52, 80);
    pointer(overlay, "pointerup", 52, 80);

    expect(calls.applyXRange).not.toHaveBeenCalled();
    expect(calls.applyYRange).toHaveBeenCalledWith(-3, 3);
  });

  it("fits on a double click inside the plot", () => {
    const { overlay, calls } = fixture();

    doubleClick(overlay, 50, 50);

    expect(calls.fitView).toHaveBeenCalledOnce();
    expect(calls.beginAxisEdit).not.toHaveBeenCalled();
  });
});
