import { describe, expect, it } from "vitest";

import type { SignalSummary } from "../generated/protocol";
import type {
  FocusEntry,
  PanelState,
  SeriesOverride,
} from "../generated/session";
import { Catalog } from "./catalog";
import {
  appliedOverrides,
  dimensionCounts,
  overrideFor,
  resolvePanel,
} from "./resolution";

function signal(sourceKey: string, channel: string): SignalSummary {
  return {
    signal_id: `${sourceKey}-${channel}`,
    source_id: sourceKey,
    source_key: sourceKey,
    local_path: channel,
    path: `${sourceKey}/${channel}`,
    unit: null,
    point_count: "1",
    t_min: 0,
    t_max: 0,
    last_value: null,
  };
}

function panel(): PanelState {
  return {
    id: "panel-1",
    title: "Panel 1",
    mode: "time",
    axis_style: "gutter",
    x_ref: null,
    color_axis: "none",
    color_ref: null,
    bindings: [],
    color_by: "source",
    overrides: [],
    focus: [],
    ghost_mode: "all",
    split_by: "none",
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

describe("resolvePanel", () => {
  const catalog = Catalog.build([
    signal("a", "temp"),
    signal("b", "temp"),
    signal("a", "speed"),
  ]);

  it("resolves picks in order and skips missing duplicates", () => {
    const state = panel();
    state.bindings = [
      {
        kind: "pick",
        selector: null,
        refs: [
          { source_key: "b", channel: "temp" },
          { source_key: "missing", channel: "temp" },
          { source_key: "b", channel: "temp" },
          { source_key: "a", channel: "speed" },
        ],
        set_id: null,
      },
    ];
    expect(resolvePanel(catalog, state, []).map((entry) => entry.path)).toEqual(
      ["b/temp", "a/speed"],
    );
  });

  it("resolves query and named pick sets", () => {
    const state = panel();
    state.bindings = [
      { kind: "query", selector: "temp", refs: [], set_id: null },
      { kind: "set", selector: null, refs: [], set_id: "picked" },
    ];
    const result = resolvePanel(catalog, state, [
      {
        id: "picked",
        name: "picked",
        kind: "pick",
        selector: null,
        refs: [{ source_key: "a", channel: "speed" }],
      },
    ]);
    expect(result.map((entry) => entry.path)).toEqual([
      "a/temp",
      "b/temp",
      "a/speed",
    ]);
  });

  it("resolves selector queries and invalid selectors to no series", () => {
    const state = panel();
    state.bindings = [
      { kind: "query", selector: "temp @ a", refs: [], set_id: null },
      { kind: "query", selector: "run_[", refs: [], set_id: null },
    ];
    expect(resolvePanel(catalog, state, []).map((entry) => entry.path)).toEqual(
      ["a/temp"],
    );

    state.bindings[0] = {
      kind: "set",
      selector: null,
      refs: [],
      set_id: "query",
    };
    expect(
      resolvePanel(catalog, state, [
        {
          id: "query",
          name: "query",
          kind: "query",
          selector: "temp @ b",
          refs: [],
        },
      ]).map((entry) => entry.path),
    ).toEqual(["b/temp"]);
  });

  it("applies styles, reserved slots, and focus", () => {
    const state = panel();
    state.bindings = [
      {
        kind: "pick",
        selector: null,
        refs: [
          { source_key: "a", channel: "temp" },
          { source_key: "b", channel: "temp" },
        ],
        set_id: null,
      },
    ];
    state.overrides = [
      {
        target_ref: { source_key: "b", channel: "temp" },
        target_selector: null,
        color_slot: 2,
        dash: "dash",
        width: 2,
        opacity: 0.5,
        visible: false,
      },
    ];
    state.focus = [
      {
        kind: "source",
        ref: null,
        source_key: "b",
        channel: null,
      },
    ];
    expect(overrideFor(state, { source_key: "b", channel: "temp" })).toBe(
      state.overrides[0],
    );
    expect(resolvePanel(catalog, state, [])).toEqual([
      expect.objectContaining({
        path: "a/temp",
        hue: 1,
        focused: false,
        overridden: false,
      }),
      expect.objectContaining({
        path: "b/temp",
        hue: 2,
        dash: "dash",
        width: 2,
        opacity: 0.5,
        visible: false,
        focused: true,
        overridden: true,
      }),
    ]);
  });

  it("assigns hue slots by source, channel, and first-appearance order", () => {
    const sources = Array.from(
      { length: 8 },
      (_, index) => `run_0${String(index + 1)}`,
    );
    const wideCatalog = Catalog.build([
      ...sources.flatMap((source) => [
        signal(source, "temp"),
        signal(source, "speed"),
      ]),
    ]);
    const state = panel();
    state.bindings = [
      {
        kind: "query",
        selector: "*",
        refs: [],
        set_id: null,
      },
    ];

    state.color_by = "source";
    expect(
      resolvePanel(wideCatalog, state, []).map((entry) => entry.hue),
    ).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 1, 1]);

    state.color_by = "channel";
    expect(
      resolvePanel(wideCatalog, state, [])
        .slice(0, 6)
        .map((entry) => entry.hue),
    ).toEqual([1, 2, 1, 2, 1, 2]);
  });

  it("assigns focus hues in focus-stack order", () => {
    const state = panel();
    state.color_by = "focus";
    state.bindings = [
      {
        kind: "pick",
        selector: null,
        refs: [
          { source_key: "b", channel: "temp" },
          { source_key: "a", channel: "speed" },
        ],
        set_id: null,
      },
    ];
    state.focus = [
      {
        kind: "series",
        ref: { source_key: "a", channel: "speed" },
        source_key: null,
        channel: null,
      },
      {
        kind: "series",
        ref: { source_key: "b", channel: "temp" },
        source_key: null,
        channel: null,
      },
    ];
    expect(resolvePanel(catalog, state, []).map((entry) => entry.hue)).toEqual([
      1, 2,
    ]);
  });

  it.each([
    ["all", [], ["rule", "rule"]],
    ["ghost", [], ["ghost", "ghost"]],
    ["all", ["b"], ["rule", "focus"]],
    ["ghost", ["b"], ["ghost", "focus"]],
  ] as const)("resolves %s display state", (ghostMode, sources, expected) => {
    const state = panel();
    state.ghost_mode = ghostMode;
    state.bindings = [
      {
        kind: "pick",
        selector: null,
        refs: [
          { source_key: "a", channel: "temp" },
          { source_key: "b", channel: "temp" },
        ],
        set_id: null,
      },
    ];
    state.focus = sources.map(
      (source): FocusEntry => ({
        kind: "source",
        ref: null,
        source_key: source,
        channel: null,
      }),
    );
    expect(
      resolvePanel(catalog, state, []).map((entry) => entry.display),
    ).toEqual(expected);
  });

  it("does not synthesize focus for an empty ghost-mode focus stack", () => {
    const state = panel();
    state.ghost_mode = "ghost";
    state.bindings = [
      {
        kind: "pick",
        selector: null,
        refs: [
          { source_key: "a", channel: "temp" },
          { source_key: "a", channel: "speed" },
          { source_key: "b", channel: "temp" },
        ],
        set_id: null,
      },
    ];

    expect(
      resolvePanel(catalog, state, []).map(({ display, focused }) => ({
        display,
        focused,
      })),
    ).toEqual([
      { display: "ghost", focused: false },
      { display: "ghost", focused: false },
      { display: "ghost", focused: false },
    ]);
  });

  it("applies selector overrides across a panel and lets later fields win", () => {
    const ruleCatalog = Catalog.build([
      signal("a", "temp"),
      signal("b", "temp"),
      signal("a", "speed"),
      signal("run_01", "temp"),
      signal("run_01", "temperature"),
    ]);
    const state = panel();
    state.bindings = [
      {
        kind: "query",
        selector: "*",
        refs: [],
        set_id: null,
      },
    ];
    state.overrides = [
      {
        target_ref: null,
        target_selector: "temp* @ run_01",
        color_slot: 3,
        dash: null,
        width: null,
        opacity: 0.2,
        visible: null,
      },
      {
        target_ref: { source_key: "run_01", channel: "temp" },
        target_selector: null,
        color_slot: 5,
        dash: "dot",
        width: 2,
        opacity: null,
        visible: null,
      },
    ];
    const result = resolvePanel(ruleCatalog, state, []);
    expect(result[0]).toEqual(
      expect.objectContaining({
        path: "a/temp",
        overridden: false,
        hue: 1,
      }),
    );
    expect(result.find((entry) => entry.path === "run_01/temp")).toEqual(
      expect.objectContaining({
        hue: 5,
        dash: "dot",
        width: 2,
        opacity: 0.2,
        overridden: true,
      }),
    );
  });

  it("flattens ghost styles but preserves visibility overrides", () => {
    const state = panel();
    state.ghost_mode = "ghost";
    state.focus = [
      {
        kind: "source",
        ref: null,
        source_key: "b",
        channel: null,
      },
    ];
    state.bindings = [
      {
        kind: "pick",
        selector: null,
        refs: [{ source_key: "a", channel: "temp" }],
        set_id: null,
      },
    ];
    state.overrides = [
      {
        target_ref: { source_key: "a", channel: "temp" },
        target_selector: null,
        color_slot: 7,
        dash: "dash",
        width: 3,
        opacity: 0.1,
        visible: false,
      },
    ];
    expect(resolvePanel(catalog, state, [])[0]).toEqual(
      expect.objectContaining({
        hue: null,
        dash: "solid",
        width: 1,
        opacity: 0.5,
        visible: false,
        overridden: true,
      }),
    );
  });

  it("counts dimensions and reports applied override match counts", () => {
    const state = panel();
    state.bindings = [
      {
        kind: "query",
        selector: "*",
        refs: [],
        set_id: null,
      },
    ];
    const overrides: SeriesOverride[] = [
      {
        target_ref: null,
        target_selector: "temp",
        color_slot: 2,
        dash: null,
        width: null,
        opacity: null,
        visible: null,
      },
      {
        target_ref: { source_key: "a", channel: "speed" },
        target_selector: null,
        color_slot: null,
        dash: "dot",
        width: null,
        opacity: null,
        visible: null,
      },
    ];
    state.overrides = overrides;
    expect(dimensionCounts(resolvePanel(catalog, state, []))).toEqual({
      sources: 2,
      channels: 2,
    });
    expect(appliedOverrides(catalog, state)).toEqual([
      { index: 0, override: overrides[0], matchCount: 2 },
      { index: 1, override: overrides[1], matchCount: 1 },
    ]);
  });
});
