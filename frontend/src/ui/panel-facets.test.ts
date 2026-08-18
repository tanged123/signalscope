// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Catalog } from "../app/catalog";
import { resolvePanel } from "../app/resolution";
import type { SignalSummary } from "../generated/protocol";
import type { PanelState } from "../generated/session";
import { ChartHost } from "../render/chart-host";
import type { GpuContext } from "../render/gpu-context";
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
    axis_equal: false,
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
    onToggleAxisEqual: vi.fn(),
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

beforeEach(() => {
  mockCanvas();
  globalThis.ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  globalThis.ResizeObserver = originalResizeObserver;
  vi.restoreAllMocks();
});

describe("PanelView panel chrome", () => {
  it("waits for a mounted panel before creating ChartGPU", () => {
    const create = vi
      .spyOn(ChartHost, "create")
      .mockResolvedValue({} as ChartHost);
    const view = new PanelView(
      "panel",
      callbacks(Catalog.build([])),
      {} as GpuContext,
    );

    expect(create).not.toHaveBeenCalled();
    document.body.appendChild(view.element);
    view.mount();

    expect(create).toHaveBeenCalledWith(
      view.element.querySelector(".chart-host"),
      expect.anything(),
    );
  });

  it("renders the legend and focus strip below a header without roster tokens", () => {
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
    expect(view.element.querySelector(".panel-focus-chip")).toBeNull();
    expect(
      view.element.querySelector<HTMLElement>(".panel-annotations")?.hidden,
    ).toBe(true);
  });

  it("ignores legacy facet state and keeps one plot surface", () => {
    const catalog = Catalog.build([signal("run-01", "temp")]);
    const view = new PanelView("panel", callbacks(catalog));
    const panel = state();

    view.update(panel, false);

    expect(view.element.querySelector(".panel-split-by")).toBeNull();
    expect(view.element.querySelector(".facet-grid")).toBeNull();
    expect(
      view.element.querySelector<HTMLCanvasElement>(".plot-canvas")?.hidden,
    ).toBe(false);
  });

  it("does not intercept Tab or Enter from descendant controls", () => {
    const catalog = Catalog.build([signal("run-01", "temp")]);
    const panelCallbacks = callbacks(catalog);
    const onFocusToggle = vi.fn();
    panelCallbacks.onFocusToggle = onFocusToggle;
    const view = new PanelView("panel", panelCallbacks);
    view.update(state(), false);
    Object.assign(view, {
      cursorT: 0,
      emphasizePaths: new Set(["run-01/temp"]),
    });
    const button =
      view.element.querySelector<HTMLButtonElement>(".panel-close");
    if (button === null) throw new Error("missing panel button");
    const tab = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    const enter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });

    button.dispatchEvent(tab);
    button.dispatchEvent(enter);

    expect(tab.defaultPrevented).toBe(false);
    expect(enter.defaultPrevented).toBe(false);
    expect(onFocusToggle).not.toHaveBeenCalled();
  });
});
