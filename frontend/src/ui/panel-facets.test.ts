// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { Catalog } from "../app/catalog";
import { resolvePanel } from "../app/resolution";
import type { SignalSummary } from "../generated/protocol";
import type { PanelState } from "../generated/session";
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
