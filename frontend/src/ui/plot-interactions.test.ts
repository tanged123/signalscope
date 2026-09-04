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

function fixture(): {
  overlay: HTMLCanvasElement;
  calls: {
    applyXRange: ReturnType<typeof vi.fn>;
    applyYRange: ReturnType<typeof vi.fn>;
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
    fitView: vi.fn(),
    setGesture: vi.fn(),
    setBox: vi.fn(),
    beginAxisEdit: vi.fn(),
  };
  const host: PlotInteractionHost = {
    layout: vi.fn(() => layout),
    applyXRange: calls.applyXRange,
    applyYRange: calls.applyYRange,
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
