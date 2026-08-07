import type { PlotInteractionPolicy } from "../app/time-plot";
import {
  allowsFit,
  boxZoomAxes,
  dragIntent,
  panAxes,
  wheelAxes,
} from "../app/plot-gestures";
import {
  clamp,
  insidePlot,
  invertX,
  invertY,
  panRange,
  panScaledRange,
  wheelZoomFactor,
  zoomDragMode,
  zoomRange,
  zoomScaledRange,
  type PlotLayout,
  type Range,
} from "../app/plot-math";

export interface InteractionBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PlotInteractionHost {
  layout(): PlotLayout | null;
  applyXRange(min: number, max: number): void;
  applyYRange(min: number, max: number): void;
  fitView(): void;
  plotClick(
    x: number,
    y: number,
    modifiers: { alt: boolean; shift: boolean },
  ): void;
  setGesture(hint: string | null): void;
  setBox(box: InteractionBox | null): void;
  axisEditZone(x: number, y: number): "x" | "y" | null;
  beginAxisEdit(axis: "x" | "y"): void;
}

export class PlotInteractionController {
  private policy: PlotInteractionPolicy | null = null;
  private box: InteractionBox | null = null;
  private dragging = false;

  constructor(
    private readonly overlay: HTMLCanvasElement,
    private readonly host: PlotInteractionHost,
  ) {
    this.bind();
  }

  setPolicy(policy: PlotInteractionPolicy | null): void {
    this.policy = policy;
  }

  isDragging(): boolean {
    return this.dragging;
  }

  private bind(): void {
    this.overlay.addEventListener(
      "wheel",
      (event) => {
        const layout = this.host.layout();
        const policy = this.policy;
        if (layout === null || policy === null) return;
        const axes = wheelAxes(policy, {
          shift: event.shiftKey,
          alt: event.altKey,
        });
        if (!axes.x && !axes.y) return;
        event.preventDefault();
        const factor = wheelZoomFactor(event.deltaY);
        if (axes.y) {
          const pivotY = invertY(
            layout,
            clamp(
              event.offsetY,
              layout.plot.y,
              layout.plot.y + layout.plot.height,
            ),
          );
          const nextY = zoomRange(layout.yRange, factor, pivotY);
          this.host.applyYRange(nextY.min, nextY.max);
        }
        if (axes.x) {
          const pivotX = invertX(
            layout,
            clamp(
              event.offsetX,
              layout.plot.x,
              layout.plot.x + layout.plot.width,
            ),
          );
          const nextX = zoomScaledRange(
            layout.xRange,
            factor,
            pivotX,
            layout.xScale,
          );
          this.host.applyXRange(nextX.min, nextX.max);
        }
      },
      { passive: false },
    );
    this.overlay.addEventListener("pointerdown", (event) => {
      const layout = this.host.layout();
      const policy = this.policy;
      if (layout === null || policy === null) return;
      const intent = dragIntent(policy, event.button, {
        ctrl: event.ctrlKey,
        meta: event.metaKey,
      });
      if (intent === "pan") {
        event.preventDefault();
        this.beginPan(event, layout, policy);
      } else if (intent === "box" || intent === "click") {
        this.beginBoxOrClick(event, layout, policy, intent === "box");
      }
    });
    this.overlay.addEventListener("dblclick", (event) => {
      const layout = this.host.layout();
      const policy = this.policy;
      if (layout === null || policy === null) return;
      const zone = this.host.axisEditZone(event.offsetX, event.offsetY);
      if (zone !== null) {
        this.host.beginAxisEdit(zone);
      } else if (
        allowsFit(policy) &&
        insidePlot(layout, event.offsetX, event.offsetY)
      ) {
        this.host.fitView();
      }
    });
  }

  /** Pans allowed axes so the data under `from` follows the pointer to `to`. */
  private panFrom(
    layout: PlotLayout,
    ranges: { x: Range; y: Range },
    from: { x: number; y: number },
    to: { x: number; y: number },
    policy: PlotInteractionPolicy,
  ): void {
    const axes = panAxes(policy);
    if (axes.x) {
      const nextX = panScaledRange(
        ranges.x,
        (from.x - to.x) / layout.plot.width,
        layout.xScale,
      );
      this.host.applyXRange(nextX.min, nextX.max);
    }
    if (axes.y) {
      const nextY = panRange(
        ranges.y,
        ((to.y - from.y) / layout.plot.height) * (ranges.y.max - ranges.y.min),
      );
      this.host.applyYRange(nextY.min, nextY.max);
    }
  }

  private beginPan(
    down: PointerEvent,
    layout: PlotLayout,
    policy: PlotInteractionPolicy,
  ): void {
    this.dragging = true;
    this.host.setGesture("drag: pan");
    this.overlay.setPointerCapture(down.pointerId);
    const startX = { ...layout.xRange };
    const startY = { ...layout.yRange };
    const move = (event: PointerEvent): void => {
      this.panFrom(
        layout,
        { x: startX, y: startY },
        { x: down.offsetX, y: down.offsetY },
        { x: event.offsetX, y: event.offsetY },
        policy,
      );
    };
    const finish = (): void => {
      this.overlay.removeEventListener("pointermove", move);
      this.overlay.removeEventListener("pointerup", finish);
      this.overlay.removeEventListener("pointercancel", finish);
      this.dragging = false;
      this.host.setGesture(null);
    };
    this.overlay.addEventListener("pointermove", move);
    this.overlay.addEventListener("pointerup", finish);
    this.overlay.addEventListener("pointercancel", finish);
  }

  private beginBoxOrClick(
    down: PointerEvent,
    layout: PlotLayout,
    policy: PlotInteractionPolicy,
    allowBox: boolean,
  ): void {
    const start = { x: down.offsetX, y: down.offsetY };
    let promoted = false;
    let axes = { x: false, y: false };
    const clampX = (value: number): number =>
      clamp(value, layout.plot.x, layout.plot.x + layout.plot.width);
    const clampY = (value: number): number =>
      clamp(value, layout.plot.y, layout.plot.y + layout.plot.height);
    const move = (event: PointerEvent): void => {
      if (
        !allowBox ||
        (!promoted &&
          Math.hypot(event.offsetX - start.x, event.offsetY - start.y) <= 4)
      ) {
        return;
      }
      const dragMode = zoomDragMode(
        event.offsetX - start.x,
        event.offsetY - start.y,
      );
      axes = boxZoomAxes(policy, dragMode);
      if (!axes.x && !axes.y) return;
      if (!promoted) {
        promoted = true;
        this.dragging = true;
        this.overlay.setPointerCapture(down.pointerId);
      }
      this.host.setGesture(zoomHint(axes));
      this.setBox({
        x0: axes.x ? clampX(start.x) : layout.plot.x,
        y0: axes.y ? clampY(start.y) : layout.plot.y,
        x1: axes.x ? clampX(event.offsetX) : layout.plot.x + layout.plot.width,
        y1: axes.y ? clampY(event.offsetY) : layout.plot.y + layout.plot.height,
      });
    };
    const finish = (event: PointerEvent): void => {
      cleanup();
      const box = this.box;
      this.setBox(null);
      if (!promoted) {
        this.host.plotClick(event.offsetX, event.offsetY, {
          alt: event.altKey,
          shift: event.shiftKey,
        });
        return;
      }
      if (box === null) return;
      if (axes.x && Math.abs(box.x1 - box.x0) <= 6) return;
      if (axes.y && Math.abs(box.y1 - box.y0) <= 6) return;
      if (axes.y) {
        this.host.applyYRange(
          invertY(layout, Math.max(box.y0, box.y1)),
          invertY(layout, Math.min(box.y0, box.y1)),
        );
      }
      if (axes.x) {
        this.host.applyXRange(
          invertX(layout, Math.min(box.x0, box.x1)),
          invertX(layout, Math.max(box.x0, box.x1)),
        );
      }
    };
    const cancel = (): void => {
      cleanup();
      this.setBox(null);
    };
    const cleanup = (): void => {
      this.overlay.removeEventListener("pointermove", move);
      this.overlay.removeEventListener("pointerup", finish);
      this.overlay.removeEventListener("pointercancel", cancel);
      this.dragging = false;
      this.host.setGesture(null);
    };
    this.overlay.addEventListener("pointermove", move);
    this.overlay.addEventListener("pointerup", finish);
    this.overlay.addEventListener("pointercancel", cancel);
  }

  private setBox(box: InteractionBox | null): void {
    this.box = box;
    this.host.setBox(box);
  }
}

function zoomHint(axes: { x: boolean; y: boolean }): string {
  if (axes.x && axes.y) return "drag: zoom";
  return `drag: zoom ${axes.x ? "X" : "Y"}`;
}
