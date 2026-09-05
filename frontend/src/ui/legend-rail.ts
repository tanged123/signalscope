import type {
  LegendAnchor,
  LegendDock,
  LegendState,
} from "../generated/session";
import { clamp } from "../app/plot-math";

const COLLAPSE = 100;
const MIN_WIDTH = 140;
const DEFAULT_WIDTH = 236;
const SEAM_WIDTH = 5;

export interface LegendRailHost {
  id: string;
  root: HTMLElement;
  position: { x: number; y: number } | null;
  size: { width: number; height: number } | null;
  anchor: LegendAnchor | null;
  dock: LegendDock | null;
  commit(layout: {
    state?: LegendState;
    position?: [number, number] | null;
    size?: [number, number] | null;
    anchor?: LegendAnchor | null;
    dock?: LegendDock | null;
  }): void;
  refresh(): void;
}

type Edge = "left" | "right" | "top" | "bottom" | "corner";

export function refreshLegendWithResizeFocus(
  root: HTMLElement,
  render: () => void,
): void {
  const active = document.activeElement;
  const edge =
    active !== null && root.contains(active)
      ? [...active.classList].find((name) =>
          /^plot-legend-resize-(left|right|top|bottom|corner)$/.test(name),
        )
      : undefined;
  render();
  if (edge !== undefined)
    root.querySelector<HTMLButtonElement>(`.${edge}`)?.focus();
}

export function legendResizeHandle(
  host: LegendRailHost,
  edge: Edge,
  legend: HTMLElement,
): HTMLButtonElement {
  const resize = document.createElement("button");
  resize.className = `plot-legend-resize plot-legend-resize-${edge}`;
  if (legend.dataset.state === "rail")
    resize.classList.add("dock-resize-handle");
  resize.type = "button";
  resize.title =
    legend.dataset.state === "rail"
      ? "Resize or collapse docked legend"
      : `Resize plot legend from the ${edge}`;
  resize.setAttribute("aria-label", resize.title);
  bindLegendResize(host, resize, legend, edge);
  return resize;
}

function bindLegendResize(
  host: LegendRailHost,
  handle: HTMLButtonElement,
  legend: HTMLElement,
  edge: Edge,
): void {
  const dock = host.dock ?? "right";
  const docked = legend.dataset.state === "rail";
  const vertical = dock === "left" || dock === "right";
  let requestedThickness: number | null = null;
  const resize = (width: number, height: number): void => {
    const box = legend.getBoundingClientRect();
    const bounds = legend.parentElement?.getBoundingClientRect();
    if (docked) requestedThickness = vertical ? width : height;
    else {
      host.position = currentLegendPosition(host, legend);
      host.anchor = null;
    }
    host.size = {
      width: docked && !vertical ? (bounds?.width ?? box.width) : width,
      height: docked && vertical ? (bounds?.height ?? box.height) : height,
    };
    positionLegend(host);
  };
  const commit = (): void => {
    if (host.size === null) return;
    if (docked) {
      const bounds = legend.parentElement?.getBoundingClientRect();
      const box = legend.getBoundingClientRect();
      const raw = requestedThickness ?? (vertical ? box.width : box.height);
      const minimum = vertical ? MIN_WIDTH : 120;
      const available = vertical
        ? (bounds?.width ?? raw)
        : (bounds?.height ?? raw);
      const thickness =
        raw < COLLAPSE
          ? 0
          : clamp(raw, minimum, Math.max(minimum, available * 0.45));
      host.commit({
        state: "rail",
        position: null,
        size: vertical
          ? [thickness, bounds?.height ?? host.size.height]
          : [bounds?.width ?? host.size.width, thickness],
        anchor: null,
        dock,
      });
      return;
    }
    host.commit({
      state: host.size.height >= 150 ? "roster" : "keys",
      position:
        host.position === null ? null : [host.position.x, host.position.y],
      size: [host.size.width, host.size.height],
      anchor: null,
      dock: null,
    });
  };
  handle.addEventListener("keydown", (event) => {
    const directions: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const direction = directions[event.key];
    if (direction === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    const box = legend.getBoundingClientRect();
    const expandKey =
      dock === "right"
        ? "ArrowLeft"
        : dock === "left"
          ? "ArrowRight"
          : dock === "top"
            ? "ArrowDown"
            : "ArrowUp";
    const collapseKey =
      dock === "right"
        ? "ArrowRight"
        : dock === "left"
          ? "ArrowLeft"
          : dock === "top"
            ? "ArrowUp"
            : "ArrowDown";
    const minimum = vertical ? MIN_WIDTH : 120;
    const thickness = vertical ? box.width : box.height;
    if (
      docked &&
      ((legend.dataset.collapsed === "true" && event.key === expandKey) ||
        (legend.dataset.collapsed !== "true" &&
          thickness <= minimum &&
          event.key === collapseKey))
    ) {
      const next = legend.dataset.collapsed === "true" ? DEFAULT_WIDTH : 0;
      resize(vertical ? next : box.width, vertical ? box.height : next);
      commit();
      return;
    }
    const step = event.shiftKey ? 48 : 16;
    const widthDelta =
      edge === "left"
        ? -direction[0] * step
        : edge === "right" || edge === "corner"
          ? direction[0] * step
          : 0;
    const heightDelta =
      edge === "top"
        ? -direction[1] * step
        : edge === "bottom" || edge === "corner"
          ? direction[1] * step
          : 0;
    resize(box.width + widthDelta, box.height + heightDelta);
    commit();
  });
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const box = legend.getBoundingClientRect();
    const start = { x: event.clientX, y: event.clientY };
    const move = (next: PointerEvent): void => {
      if (next.pointerId !== event.pointerId) return;
      const dx = next.clientX - start.x;
      const dy = next.clientY - start.y;
      resize(
        box.width +
          (edge === "left"
            ? -dx
            : edge === "right" || edge === "corner"
              ? dx
              : 0),
        box.height +
          (edge === "top"
            ? -dy
            : edge === "bottom" || edge === "corner"
              ? dy
              : 0),
      );
    };
    const end = (next: PointerEvent): void => {
      if (next.pointerId !== event.pointerId) return;
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", end);
      document.removeEventListener("pointercancel", end);
      commit();
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", end);
    document.addEventListener("pointercancel", end);
  });
}

export function bindLegendDrag(
  host: LegendRailHost,
  handle: HTMLButtonElement,
  legend: HTMLElement,
): void {
  handle.addEventListener("keydown", (event) => {
    if (event.key === "End") {
      event.preventDefault();
      dockLegend(host, legend, nearestLegendEdge(host, legend) ?? "right");
      return;
    }
    const directions: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const direction = directions[event.key];
    if (direction === undefined) return;
    event.preventDefault();
    const step = event.shiftKey ? 24 : 8;
    const current = currentLegendPosition(host, legend);
    host.position = {
      x: current.x + direction[0] * step,
      y: current.y + direction[1] * step,
    };
    host.anchor = null;
    positionLegend(host);
    commitLegendPosition(host);
  });
  handle.addEventListener("dblclick", () => {
    const wrap = legend.parentElement;
    if (wrap === null) return;
    const bounds = wrap.getBoundingClientRect();
    const box = legend.getBoundingClientRect();
    const current = currentLegendPosition(host, legend);
    const horizontal =
      current.x + box.width / 2 < bounds.width / 2 ? "left" : "right";
    const vertical =
      current.y + box.height / 2 < bounds.height / 2 ? "top" : "bottom";
    host.anchor = `${vertical}_${horizontal}` as LegendAnchor;
    host.position = null;
    positionLegend(host);
    host.commit({ position: null, anchor: host.anchor });
  });
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const origin = currentLegendPosition(host, legend);
    const start = { x: event.clientX, y: event.clientY };
    const move = (next: PointerEvent): void => {
      if (next.pointerId !== event.pointerId) return;
      host.position = {
        x: origin.x + next.clientX - start.x,
        y: origin.y + next.clientY - start.y,
      };
      host.anchor = null;
      positionLegend(host);
      const wrap = legend.parentElement;
      if (wrap !== null) {
        const preview = nearestLegendEdge(host, legend, 56);
        if (preview === null) delete wrap.dataset.legendDockPreview;
        else wrap.dataset.legendDockPreview = preview;
      }
    };
    const end = (next: PointerEvent): void => {
      if (next.pointerId !== event.pointerId) return;
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", end);
      document.removeEventListener("pointercancel", end);
      const wrap = legend.parentElement;
      if (wrap !== null) delete wrap.dataset.legendDockPreview;
      const dock = nearestLegendEdge(host, legend, 20);
      if (dock === null) commitLegendPosition(host);
      else dockLegend(host, legend, dock);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", end);
    document.addEventListener("pointercancel", end);
  });
}

export function floatLegend(host: LegendRailHost, legend: HTMLElement): void {
  const bounds = legend.parentElement?.getBoundingClientRect();
  const box = legend.getBoundingClientRect();
  const maxHeight = Math.max(150, (bounds?.height ?? box.height) * 0.6);
  host.commit({
    state: "roster",
    position: null,
    size: [box.width, clamp(280, 150, maxHeight)],
    anchor: "top_right",
    dock: null,
  });
}

export function positionLegend(host: LegendRailHost): void {
  const legend = host.root.querySelector<HTMLElement>(".plot-series-legend");
  if (legend === null) return;
  const wrap = legend.parentElement;
  if (wrap === null) return;
  const bounds = wrap.getBoundingClientRect();
  const state = legend.dataset.state as LegendState | undefined;
  if (state === "rail") {
    const dock = host.dock ?? "right";
    const vertical = dock === "left" || dock === "right";
    const requested = vertical
      ? (host.size?.width ?? DEFAULT_WIDTH)
      : (host.size?.height ?? DEFAULT_WIDTH);
    const collapsed = requested < COLLAPSE;
    const minimum = vertical ? MIN_WIDTH : 120;
    const available = vertical ? bounds.width : bounds.height;
    const thickness = collapsed
      ? SEAM_WIDTH
      : clamp(requested, minimum, Math.max(minimum, available * 0.45));
    host.size = {
      width: vertical ? (collapsed ? 0 : thickness) : bounds.width,
      height: vertical ? bounds.height : collapsed ? 0 : thickness,
    };
    wrap.classList.add("legend-rail");
    wrap.classList.toggle("legend-rail-collapsed", collapsed);
    wrap.dataset.legendDock = dock;
    wrap.style.setProperty(
      "--plot-legend-rail-width",
      `${String(vertical ? thickness : 0)}px`,
    );
    wrap.style.setProperty(
      "--plot-legend-rail-height",
      `${String(vertical ? 0 : thickness)}px`,
    );
    legend.dataset.dock = dock;
    legend.dataset.collapsed = String(collapsed);
    legend.style.width = vertical ? `${String(thickness)}px` : "100%";
    legend.style.height = vertical ? "100%" : `${String(thickness)}px`;
    legend.style.left = dock === "right" ? "auto" : "0";
    legend.style.right = dock === "left" ? "auto" : "0";
    legend.style.top = dock === "bottom" ? "auto" : "0";
    legend.style.bottom = dock === "top" ? "auto" : "0";
    host.refresh();
    return;
  }
  wrap.classList.remove("legend-rail", "legend-rail-collapsed");
  delete wrap.dataset.legendDock;
  wrap.style.removeProperty("--plot-legend-rail-width");
  wrap.style.removeProperty("--plot-legend-rail-height");
  delete legend.dataset.dock;
  delete legend.dataset.collapsed;
  legend.style.removeProperty("bottom");
  if (state === "badge") {
    legend.style.removeProperty("width");
    legend.style.removeProperty("height");
  } else if (host.size !== null) {
    const width = clamp(
      host.size.width,
      140,
      Math.max(140, bounds.width * 0.4),
    );
    const height =
      state === "roster"
        ? clamp(host.size.height, 150, Math.max(150, bounds.height - 16))
        : host.size.height;
    host.size = { width, height };
    legend.style.width = `${String(width)}px`;
    if (state === "roster") legend.style.height = `${String(height)}px`;
    else legend.style.removeProperty("height");
  } else {
    legend.style.removeProperty("width");
    legend.style.removeProperty("height");
  }
  const box = legend.getBoundingClientRect();
  const position = currentLegendPosition(host, legend);
  const x = Math.min(
    Math.max(8, position.x),
    Math.max(8, bounds.width - box.width - 8),
  );
  const y = Math.min(
    Math.max(8, position.y),
    Math.max(8, bounds.height - box.height - 8),
  );
  if (host.anchor === null && host.position !== null) host.position = { x, y };
  legend.style.left = `${String(x)}px`;
  legend.style.top = `${String(y)}px`;
  legend.style.right = "auto";
  host.refresh();
}

function currentLegendPosition(
  host: LegendRailHost,
  legend: HTMLElement,
): { x: number; y: number } {
  if (host.position !== null) return host.position;
  const wrap = legend.parentElement;
  if (wrap === null) return { x: 8, y: 8 };
  const bounds = wrap.getBoundingClientRect();
  const box = legend.getBoundingClientRect();
  const anchor = host.anchor ?? "top_right";
  return {
    x: anchor.endsWith("right") ? bounds.width - box.width - 8 : 8,
    y: anchor.startsWith("bottom") ? bounds.height - box.height - 8 : 8,
  };
}

export function nearestLegendEdge(
  host: LegendRailHost,
  legend: HTMLElement,
  threshold = Number.POSITIVE_INFINITY,
): LegendDock | null {
  const wrap = legend.parentElement;
  if (wrap === null) return null;
  const bounds = wrap.getBoundingClientRect();
  const box = legend.getBoundingClientRect();
  const position = currentLegendPosition(host, legend);
  const distances: Array<[LegendDock, number]> = [
    ["left", position.x],
    ["right", bounds.width - position.x - box.width],
    ["top", position.y],
    ["bottom", bounds.height - position.y - box.height],
  ];
  distances.sort((left, right) => left[1] - right[1]);
  const nearest = distances[0];
  return nearest !== undefined && nearest[1] <= threshold ? nearest[0] : null;
}

function dockLegend(
  host: LegendRailHost,
  legend: HTMLElement,
  dock: LegendDock,
): void {
  const box = legend.getBoundingClientRect();
  const bounds = legend.parentElement?.getBoundingClientRect();
  const vertical = dock === "left" || dock === "right";
  host.commit({
    state: "rail",
    position: null,
    size: vertical
      ? [box.width, bounds?.height ?? box.height]
      : [bounds?.width ?? box.width, box.height],
    anchor: null,
    dock,
  });
}

function commitLegendPosition(host: LegendRailHost): void {
  if (host.position === null) return;
  host.commit({
    position: [host.position.x, host.position.y],
    anchor: null,
    dock: null,
  });
}
