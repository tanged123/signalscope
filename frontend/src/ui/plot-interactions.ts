import type { PlotInteractionPolicy } from "../app/plot-capabilities";
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
  pinchRange,
  pinchScaledRange,
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
  plotClick(x: number, y: number): void;
  pinAt(x: number, y: number, radius: number): void;
  removeAt(x: number, y: number, radius: number): boolean;
  publishTouchCursor(event: PointerEvent): void;
  setGesture(hint: string | null): void;
  setBox(box: InteractionBox | null): void;
  axisEditZone(x: number, y: number): "x" | "y" | "c" | null;
  beginAxisEdit(axis: "x" | "y" | "c"): void;
}

const TOUCH = {
  /** Movement that promotes a tap to a pan. */
  panSlop: 9,
  /** Finger separation below which an axis pans instead of zooming. */
  pinchSeparation: 40,
  longPressMs: 430,
  longPressRadius: 28,
  tapRemoveRadius: 16,
  doubleTapMs: 320,
  doubleTapRadius: 26,
} as const;

export class PlotInteractionController {
  private policy: PlotInteractionPolicy | null = null;
  private box: InteractionBox | null = null;
  private dragging = false;
  private readonly touchPoints = new Map<number, { x: number; y: number }>();
  private touchMode: "tap" | "pan" | "pinch" | "dead" | null = null;
  private touchStart: { x: number; y: number } | null = null;
  private touchStartRanges: { x: Range; y: Range } | null = null;
  private pinchAnchors: {
    xA: number;
    xB: number;
    yA: number;
    yB: number;
  } | null = null;
  private longPressTimer: number | null = null;
  private lastTap = { time: 0, x: 0, y: 0 };

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
      if (event.pointerType === "touch") {
        this.beginTouch(event, layout, policy);
        return;
      }
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
    this.overlay.addEventListener("pointermove", (event) => {
      if (event.pointerType === "touch") this.moveTouch(event);
    });
    this.overlay.addEventListener("pointerup", (event) => {
      if (event.pointerType === "touch") this.endTouch(event);
    });
    this.overlay.addEventListener("pointercancel", (event) => {
      if (event.pointerType === "touch") this.endTouch(event);
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

  private beginTouch(
    event: PointerEvent,
    layout: PlotLayout,
    policy: PlotInteractionPolicy,
  ): void {
    this.overlay.setPointerCapture(event.pointerId);
    this.touchPoints.set(event.pointerId, {
      x: event.offsetX,
      y: event.offsetY,
    });
    if (this.touchPoints.size === 2) {
      this.clearLongPress();
      this.setBox(null);
      const [first, second] = [...this.touchPoints.values()];
      if (first === undefined || second === undefined) return;
      // Anchors are captured in data space so both stay under their finger.
      this.pinchAnchors = {
        xA: invertX(layout, first.x),
        xB: invertX(layout, second.x),
        yA: invertY(layout, first.y),
        yB: invertY(layout, second.y),
      };
      this.touchMode = "pinch";
      return;
    }
    if (this.touchPoints.size > 2) {
      this.touchMode = "dead";
      return;
    }
    this.touchStart = { x: event.offsetX, y: event.offsetY };
    this.touchStartRanges = {
      x: { ...layout.xRange },
      y: { ...layout.yRange },
    };
    this.touchMode = "tap";
    this.longPressTimer = window.setTimeout(() => {
      this.longPressTimer = null;
      if (this.touchMode !== "tap" || this.touchStart === null) return;
      this.host.pinAt(
        this.touchStart.x,
        this.touchStart.y,
        TOUCH.longPressRadius,
      );
      const vibrate = (navigator as { vibrate?: Navigator["vibrate"] }).vibrate;
      vibrate?.call(navigator, [8]);
      this.touchMode = "dead";
    }, TOUCH.longPressMs);
    if (!panAxes(policy).x && !panAxes(policy).y) {
      this.touchStartRanges = null;
    }
  }

  private moveTouch(event: PointerEvent): void {
    const layout = this.host.layout();
    const policy = this.policy;
    if (
      layout === null ||
      policy === null ||
      this.touchMode === null ||
      this.touchMode === "dead"
    ) {
      return;
    }
    const point = this.touchPoints.get(event.pointerId);
    if (point === undefined) return;
    point.x = event.offsetX;
    point.y = event.offsetY;
    if (this.touchMode === "pinch") {
      this.applyPinch(layout, policy);
      return;
    }
    const start = this.touchStart;
    const ranges = this.touchStartRanges;
    if (start === null) return;
    if (
      this.touchMode === "tap" &&
      Math.hypot(event.offsetX - start.x, event.offsetY - start.y) >
        TOUCH.panSlop
    ) {
      this.clearLongPress();
      if (ranges !== null) this.touchMode = "pan";
    }
    if (this.touchMode !== "pan" || ranges === null) return;
    this.panFrom(
      layout,
      ranges,
      start,
      { x: event.offsetX, y: event.offsetY },
      policy,
    );
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

  private applyPinch(layout: PlotLayout, policy: PlotInteractionPolicy): void {
    const anchors = this.pinchAnchors;
    const [first, second] = [...this.touchPoints.values()];
    if (anchors === null || first === undefined || second === undefined) return;
    const axes = wheelAxes(policy, { shift: false, alt: false });
    const { plot } = layout;
    if (axes.x && Math.abs(first.x - second.x) > TOUCH.pinchSeparation) {
      const next = pinchScaledRange(
        anchors.xA,
        anchors.xB,
        first.x,
        second.x,
        plot.x,
        plot.x + plot.width,
        layout.xScale,
      );
      if (next !== null) this.host.applyXRange(next.min, next.max);
    }
    if (axes.y && Math.abs(first.y - second.y) > TOUCH.pinchSeparation) {
      const next = pinchRange(
        anchors.yA,
        anchors.yB,
        first.y,
        second.y,
        plot.y,
        plot.y + plot.height,
      );
      if (next !== null) this.host.applyYRange(next.min, next.max);
    }
  }

  private endTouch(event: PointerEvent): void {
    this.touchPoints.delete(event.pointerId);
    if (this.touchMode === "pinch" && this.touchPoints.size < 2) {
      this.touchMode = this.touchPoints.size === 0 ? null : "dead";
      this.pinchAnchors = null;
      return;
    }
    if (this.touchMode !== "tap") {
      if (this.touchPoints.size === 0) this.touchMode = null;
      return;
    }
    this.clearLongPress();
    this.touchMode = null;
    const policy = this.policy;
    if (policy === null) return;
    const now = performance.now();
    const doubleTap =
      now - this.lastTap.time < TOUCH.doubleTapMs &&
      Math.hypot(
        event.offsetX - this.lastTap.x,
        event.offsetY - this.lastTap.y,
      ) < TOUCH.doubleTapRadius;
    if (doubleTap && allowsFit(policy)) {
      this.lastTap = { time: 0, x: 0, y: 0 };
      this.host.fitView();
      return;
    }
    this.lastTap = { time: now, x: event.offsetX, y: event.offsetY };
    if (
      this.host.removeAt(event.offsetX, event.offsetY, TOUCH.tapRemoveRadius)
    ) {
      return;
    }
    this.host.publishTouchCursor(event);
  }

  private clearLongPress(): void {
    if (this.longPressTimer !== null) {
      window.clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
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
        this.host.plotClick(event.offsetX, event.offsetY);
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
