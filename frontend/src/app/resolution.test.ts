import { describe, expect, it } from "vitest";

import type { SignalSummary } from "../generated/protocol";
import type { PanelState } from "../generated/session";
import { Catalog } from "./catalog";
import { overrideFor, resolvePanel } from "./resolution";

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
        colorSlot: 1,
        focused: false,
      }),
      expect.objectContaining({
        path: "b/temp",
        colorSlot: 2,
        dash: "dash",
        width: 2,
        opacity: 0.5,
        visible: false,
        focused: true,
      }),
    ]);
  });
});
