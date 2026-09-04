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
  host: PlotInteractionHost;
  controller: PlotInteractionController;
} {
  const overlay = document.createElement("canvas");
  overlay.setPointerCapture = vi.fn();
  const host: PlotInteractionHost = {
    layout: vi.fn(() => layout),
    applyXRange: vi.fn(),
    applyYRange: vi.fn(),
    fitView: vi.fn(),
    plotClick: vi.fn(),
    setGesture: vi.fn(),
    setBox: vi.fn(),
    axisEditZone: vi.fn(() => null),
    beginAxisEdit: vi.fn(),
  };
  const controller = new PlotInteractionController(overlay, host);
  controller.setPolicy(TIME_POLICY);
  return { overlay, host, controller };
}

describe("PlotInteractionController", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("locks horizontal drags to X and applies the selected range", () => {
    const { overlay, host } = fixture();

    pointer(overlay, "pointerdown", 20, 50);
    pointer(overlay, "pointermove", 80, 52);

    expect(host.setGesture).toHaveBeenLastCalledWith("drag: zoom X");
    expect(host.setBox).toHaveBeenLastCalledWith({
      x0: 20,
      y0: 0,
      x1: 80,
      y1: 100,
    });

    pointer(overlay, "pointerup", 80, 52);

    expect(host.applyXRange).toHaveBeenCalledWith(2, 8);
    expect(host.applyYRange).not.toHaveBeenCalled();
    expect(host.setGesture).toHaveBeenLastCalledWith(null);
    expect(host.setBox).toHaveBeenLastCalledWith(null);
  });

  it("locks vertical drags to Y without changing X", () => {
    const { overlay, host } = fixture();

    pointer(overlay, "pointerdown", 50, 20);
    pointer(overlay, "pointermove", 52, 80);
    pointer(overlay, "pointerup", 52, 80);

    expect(host.applyXRange).not.toHaveBeenCalled();
    expect(host.applyYRange).toHaveBeenCalledWith(-3, 3);
  });

  it("fits on a double click inside the plot", () => {
    const { overlay, host } = fixture();

    doubleClick(overlay, 50, 50);

    expect(host.fitView).toHaveBeenCalledOnce();
    expect(host.beginAxisEdit).not.toHaveBeenCalled();
  });
});
