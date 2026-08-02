// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { Catalog } from "../app/catalog";
import { resolvePanel } from "../app/resolution";
import type { SignalSummary, TileResponse } from "../generated/protocol";
import type { PanelState } from "../generated/session";
import { CanvasRenderer } from "../render/canvas-renderer";
import { PanelView, type PanelCallbacks } from "./panel";

function signal(source: string, channel: string): SignalSummary {
  return {
    signal_id: `${source}-${channel}`,
    source_id: source,
    source_key: source,
    local_path: channel,
    path: `${source}/${channel}`,
    unit: null,
    point_count: "1",
    t_min: 0,
    t_max: 1,
    last_value: null,
  };
}

function tiles(paths: readonly string[]): TileResponse {
  return {
    request_id: "facet",
    series: paths.map((path) => ({
      signal_id: path,
      signal_path: path,
      unit: null,
      level: 0,
      bins: [
        {
          t0: 0,
          t1: 1,
          first: 1,
          last: 1,
          min: 1,
          max: 1,
          sum: 1,
          sum_sq: 1,
          finite_count: "1",
          sample_count: "1",
          has_gap: false,
        },
      ],
    })),
  };
}

function state(): PanelState {
  return {
    id: "panel",
    title: "Panel",
    mode: "time",
    axis_style: "gutter",
    x_ref: null,
    color_axis: "none",
    color_ref: null,
    bindings: [{ kind: "query", selector: "*", refs: [], set_id: null }],
    color_by: "source",
    overrides: [],
    focus: [],
    ghost_mode: "all",
    split_by: "source",
    y_range: null,
    x_range: null,
    x_label: null,
    y_label: null,
    c_label: null,
    time_window: null,
    annotations: [],
    show_stats: false,
  };
}

function callbacks(catalog: Catalog): PanelCallbacks {
  return {
    onFocus: vi.fn(),
    onClose: vi.fn(),
    onSplitRight: vi.fn(),
    onSplitDown: vi.fn(),
    onMaximize: vi.fn(),
    onSelectMode: vi.fn(),
    onSetSplitBy: vi.fn(),
    onDropSignals: vi.fn(),
    onDropSet: vi.fn(),
    onFocusToggle: vi.fn(),
    onClearFocus: vi.fn(),
    onMuteSelector: vi.fn(),
    onMuteSeries: vi.fn(),
    onRemoveBinding: vi.fn(),
    onToggleGhostMode: vi.fn(),
    localPathFor: () => null,
    sourceKeyFor: () => null,
    pathForRef: (ref) => `${ref.source_key}/${ref.channel}`,
    catalog: () => catalog,
    namedSets: () => [],
    resolveSeries: (panel) => resolvePanel(catalog, panel, []),
    onSetXSignal: vi.fn(),
    onSetColorSignal: vi.fn(),
    onClearXSignal: vi.fn(),
    onToggleSeries: vi.fn(),
    onResized: vi.fn(),
    onGesture: vi.fn(),
    onCursor: vi.fn(),
    onTimeWindow: vi.fn(),
    onYRange: vi.fn(),
    onXRange: vi.fn(),
    onPinAnnotation: vi.fn(),
    onRemoveAnnotation: vi.fn(),
    onEditAnnotationLabel: vi.fn(),
    onFitView: vi.fn(),
    onToggleStats: vi.fn(),
    onToggleAxisStyle: vi.fn(),
    onRenameTitle: vi.fn(),
    onEditAxisLabel: vi.fn(),
    onSetColorBy: vi.fn(),
    onRemoveOverride: vi.fn(),
    onClearOverrides: vi.fn(),
    onSetSeriesStyle: vi.fn(),
    onRemoveSeries: vi.fn(),
    onQuickTransform: vi.fn(),
  };
}

const originalResizeObserver = globalThis.ResizeObserver;

function mockCanvas(): void {
  const context = new Proxy(
    {},
    {
      get: (_target, property: string) => {
        if (property === "measureText") return () => ({ width: 0 });
        if (property === "createLinearGradient") {
          return () => ({ addColorStop: vi.fn() });
        }
        return vi.fn();
      },
    },
  ) as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
}

afterEach(() => {
  globalThis.ResizeObserver = originalResizeObserver;
  vi.restoreAllMocks();
});

describe("PanelView facets", () => {
  it("renders the legend and focus strip below a header without roster tokens", () => {
    mockCanvas();
    globalThis.ResizeObserver = class {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    } as unknown as typeof ResizeObserver;
    const catalog = Catalog.build([
      signal("run-01", "temp"),
      signal("run-02", "temp"),
    ]);
    const view = new PanelView("panel", callbacks(catalog));
    const panel = state();
    panel.split_by = "none";
    panel.focus = [
      {
        kind: "series",
        ref: { source_key: "run-01", channel: "temp" },
        source_key: null,
        channel: null,
      },
    ];
    view.update(panel, false);

    const strip = view.element.querySelector<HTMLElement>(
      ".panel-legend-strip",
    );
    expect(strip).not.toBeNull();
    expect(strip?.querySelectorAll(".legend-count-token")).toHaveLength(2);
    expect(strip?.querySelectorAll(".matrix-focus-chip")).toHaveLength(1);
    expect(strip?.querySelector(".color-rule-token")?.textContent).toBe(
      "color ← source",
    );
    expect(strip?.textContent).toContain(
      "hover explore · ⇧click focus · ⌥ mute · esc clear",
    );
    expect(
      view.element.querySelectorAll(".panel-header .legend-count-token"),
    ).toHaveLength(0);
    expect(
      view.element.querySelector<HTMLElement>(".panel-focus-chip")?.hidden,
    ).toBe(false);
    expect(
      view.element.querySelector<HTMLElement>(".panel-annotations")?.hidden,
    ).toBe(true);
  });

  it("renders bounded facet cells and fans the linked cursor line out", () => {
    mockCanvas();
    globalThis.ResizeObserver = class {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    } as unknown as typeof ResizeObserver;
    const catalog = Catalog.build(
      Array.from({ length: 20 }, (_, index) =>
        signal(`run-${String(index).padStart(2, "0")}`, "temp"),
      ),
    );
    const view = new PanelView("panel", callbacks(catalog));
    const host = document.createElement("div");
    document.body.appendChild(host);
    host.appendChild(view.element);
    const panel = state();
    view.renderData(panel, null, null, { t0: 0, t1: 1 });

    expect(view.element.querySelectorAll(".facet-cell")).toHaveLength(17);
    expect(view.element.querySelectorAll(".facet-cell-canvas")).toHaveLength(
      16,
    );
    expect(view.element.textContent).toContain(
      "+4 more — tighten the selector",
    );
    view.setCursorMode("track");
    view.setCursor(0.5);
    expect(view.element.querySelectorAll(".facet-cursor")).toHaveLength(16);

    panel.split_by = "none";
    view.renderData(panel, null, null, { t0: 0, t1: 1 });
    expect(view.element.querySelector<HTMLElement>(".facet-grid")?.hidden).toBe(
      true,
    );
    expect(
      view.element.querySelector<HTMLCanvasElement>(".plot-canvas")?.hidden,
    ).toBe(false);
  });

  it("attaches facet canvases before rendering and routes cell gestures", () => {
    mockCanvas();
    globalThis.ResizeObserver = class {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    } as unknown as typeof ResizeObserver;
    vi.spyOn(HTMLCanvasElement.prototype, "clientWidth", "get").mockReturnValue(
      200,
    );
    vi.spyOn(
      HTMLCanvasElement.prototype,
      "clientHeight",
      "get",
    ).mockReturnValue(100);
    const catalog = Catalog.build(
      Array.from({ length: 8 }, (_, index) =>
        signal(`run-${String(index).padStart(2, "0")}`, "temp"),
      ),
    );
    const panelCallbacks = callbacks(catalog);
    const view = new PanelView("panel", panelCallbacks);
    const host = document.createElement("div");
    document.body.appendChild(host);
    host.appendChild(view.element);
    const panel = state();
    const paths = Array.from(
      { length: 8 },
      (_, index) => `run-${String(index).padStart(2, "0")}/temp`,
    );
    const render = vi.spyOn(CanvasRenderer.prototype, "render");

    view.renderData(panel, tiles(paths), null, { t0: 0, t1: 1 });

    expect(render).toHaveBeenCalledTimes(8);
    expect(
      render.mock.contexts.every((instance) => {
        const canvas = (
          instance as unknown as { surface: { canvas: HTMLCanvasElement } }
        ).surface.canvas;
        return canvas.isConnected && canvas.width > 1 && canvas.height > 1;
      }),
    ).toBe(true);
    const grid = view.element.querySelector<HTMLElement>(".facet-grid");
    expect(grid?.style.gridTemplateColumns).toBe("repeat(3, minmax(0, 1fr))");

    const canvas = grid?.querySelector<HTMLCanvasElement>(".facet-cell-canvas");
    if (canvas === null || canvas === undefined)
      throw new Error("facet missing");
    Object.defineProperty(canvas, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 0,
        top: 0,
        right: 200,
        bottom: 100,
        width: 200,
        height: 100,
      }),
    });
    canvas.dispatchEvent(
      new MouseEvent("pointermove", {
        bubbles: true,
        clientX: 120,
        clientY: 37,
      }),
    );
    expect(
      view.element.querySelector(".plot-hover-tag")?.textContent,
    ).toContain("run-00/temp");

    const focusedCanvas =
      grid?.querySelector<HTMLCanvasElement>(".facet-cell-canvas");
    if (focusedCanvas === null || focusedCanvas === undefined) {
      throw new Error("facet missing after hover");
    }
    Object.defineProperty(focusedCanvas, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 0,
        top: 0,
        right: 200,
        bottom: 100,
        width: 200,
        height: 100,
      }),
    });
    focusedCanvas.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        shiftKey: true,
        clientX: 120,
        clientY: 37,
      }),
    );
    expect(panelCallbacks.onFocusToggle).toHaveBeenCalledWith(
      "panel",
      expect.objectContaining({
        ref: { source_key: "run-00", channel: "temp" },
      }),
    );
  });

  it("disables split for non-time modes", () => {
    mockCanvas();
    globalThis.ResizeObserver = class {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    } as unknown as typeof ResizeObserver;
    const catalog = Catalog.build([signal("run-01", "temp")]);
    const view = new PanelView("panel", callbacks(catalog));
    const panel = state();
    panel.mode = "xy";
    view.update(panel, false);

    expect(
      view.element.querySelector<HTMLButtonElement>(".panel-split-by")
        ?.disabled,
    ).toBe(true);
    expect(
      view.element.querySelector<HTMLButtonElement>(".panel-split-by")?.title,
    ).toBe("Split applies to time panels");
  });
});
