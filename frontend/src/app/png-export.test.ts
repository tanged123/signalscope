import { describe, expect, it } from "vitest";

import type { PanelState, WorkspaceTab } from "../generated/session";
import { panelPngTargets } from "./png-export";

function panel(id: string, title: string): PanelState {
  return {
    id,
    title,
    axis_style: "gutter",
    bindings: [],
    color_by: "source",
    dash_by: null,
    width_by: null,
    line_width: 1.4,
    ghost_opacity: 0.5,
    overrides: [],
    focus: [],
    ghost_mode: "all",
    legend_state: "keys",
    legend_position: null,
    legend_size: null,
    legend_anchor: null,
    legend_dock: null,
    legend_hint_dismissed: false,
    x_axis: { kind: "time" },
    y_range: null,
    x_range: null,
    x_label: null,
    y_label: null,
    time_window: null,
    annotations: [],
    annotation_display: "labels",
    show_stats: false,
    stat_columns: ["min", "max", "mean", "rms", "cursor"],
    stats_sort: null,
    stats_sort_descending: false,
  };
}

function tab(
  id: string,
  title: string,
  panels: PanelState[],
  layoutIds: string[],
): WorkspaceTab {
  return {
    id,
    title,
    cursor_mode: "none",
    focused_panel_id: panels[0]?.id ?? null,
    maximized_panel_id: null,
    panels,
    layout: [
      {
        height: 1,
        panels: layoutIds.map((panelId) => ({
          panel_id: panelId,
          width: 1 / layoutIds.length,
        })),
      },
    ],
  };
}

describe("all-panel PNG targets", () => {
  it("uses tab and layout order, then includes unplaced panels", () => {
    const first = panel("panel-1", "First");
    const second = panel("panel-2", "Second");
    const unplaced = panel("panel-3", "Unplaced");
    const other = panel("panel-4", "Other");

    expect(
      panelPngTargets([
        tab(
          "workspace-1",
          "Run A",
          [first, second, unplaced],
          [second.id, first.id],
        ),
        tab("workspace-2", "Run B", [other], [other.id]),
      ]),
    ).toEqual([
      {
        tabId: "workspace-1",
        panelId: "panel-2",
        fileName: "Run A-Second.png",
      },
      {
        tabId: "workspace-1",
        panelId: "panel-1",
        fileName: "Run A-First.png",
      },
      {
        tabId: "workspace-1",
        panelId: "panel-3",
        fileName: "Run A-Unplaced.png",
      },
      {
        tabId: "workspace-2",
        panelId: "panel-4",
        fileName: "Run B-Other.png",
      },
    ]);
  });

  it("sanitizes names and suffixes collisions", () => {
    expect(
      panelPngTargets([
        tab(
          "workspace-1",
          "Run/A",
          [panel("panel-1", "Speed:x"), panel("panel-2", "Speed?x")],
          ["panel-1", "panel-2"],
        ),
      ]).map((target) => target.fileName),
    ).toEqual(["Run-A-Speed-x.png", "Run-A-Speed-x-2.png"]);
  });
});
