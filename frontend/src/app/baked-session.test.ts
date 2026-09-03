import { describe, expect, it } from "vitest";

import { SESSION_SCHEMA_VERSION } from "../generated/session";
import { parseBakedSession } from "./baked-session";
import { emptySession, WorkspaceModel } from "./workspace";

describe("parseBakedSession", () => {
  it("accepts a current-version session", () => {
    const json = JSON.stringify(emptySession());
    expect(parseBakedSession(json).schema_version).toBe(SESSION_SCHEMA_VERSION);
  });

  it("normalizes omitted optional annotation X pins", () => {
    const model = new WorkspaceModel();
    const panel = model.addPanelRow();
    panel.annotations = [
      {
        id: "tip-1",
        series_path: "run/y",
        anchor: 1,
        pinned_x: null,
        pinned_value: 2,
        label: "tip",
        offset: [10, -10],
      },
    ];
    const parsed = JSON.parse(JSON.stringify(model.snapshot())) as {
      tabs: { panels: { annotations: Record<string, unknown>[] }[] }[];
    };
    const annotation = parsed.tabs[0]?.panels[0]?.annotations[0];
    if (annotation === undefined) throw new Error("annotation is missing");
    delete annotation.pinned_x;

    const restored = parseBakedSession(JSON.stringify(parsed));

    expect(restored.tabs[0]?.panels[0]?.annotations[0]?.pinned_x).toBeNull();
  });

  it("round-trips current panel style and statistic fields", () => {
    const model = new WorkspaceModel();
    const panel = model.addPanelRow();
    panel.color_by = null;
    panel.dash_by = "channel";
    panel.width_by = "attr";
    panel.line_width = 2.5;
    panel.ghost_opacity = 0.25;
    panel.stat_columns = ["min", "cursor", "n"];
    panel.stats_sort = "n";
    panel.stats_sort_descending = true;

    const restored = parseBakedSession(JSON.stringify(model.snapshot()));

    expect(restored.tabs[0]?.panels[0]).toMatchObject({
      color_by: null,
      dash_by: "channel",
      width_by: "attr",
      line_width: 2.5,
      ghost_opacity: 0.25,
      stat_columns: ["min", "cursor", "n"],
      stats_sort: "n",
      stats_sort_descending: true,
    });
  });

  it.each([0, 1])("accepts ghost opacity at boundary %s", (opacity) => {
    const model = new WorkspaceModel();
    model.addPanelRow().ghost_opacity = opacity;

    expect(() =>
      parseBakedSession(JSON.stringify(model.snapshot())),
    ).not.toThrow();
  });

  it.each([-0.1, 1.1])(
    "rejects ghost opacity outside [0, 1]: %s",
    (opacity) => {
      const model = new WorkspaceModel();
      model.addPanelRow().ghost_opacity = opacity;

      expect(() => parseBakedSession(JSON.stringify(model.snapshot()))).toThrow(
        /structure/,
      );
    },
  );

  it("rejects duplicate statistic columns", () => {
    const model = new WorkspaceModel();
    model.addPanelRow().stat_columns = ["min", "min"];

    expect(() => parseBakedSession(JSON.stringify(model.snapshot()))).toThrow(
      /structure/,
    );
  });

  it("rejects a statistic sort column not in the selected columns", () => {
    const model = new WorkspaceModel();
    const panel = model.addPanelRow();
    panel.stat_columns = ["min"];
    panel.stats_sort = "max";

    expect(() => parseBakedSession(JSON.stringify(model.snapshot()))).toThrow(
      /structure/,
    );
  });

  it("rejects an X axis source whose kind and reference disagree", () => {
    const model = new WorkspaceModel();
    const panel = model.addPanelRow();
    panel.x_axis = {
      kind: "time",
      ref: { source_key: "run", channel: "x" },
    };

    expect(() => parseBakedSession(JSON.stringify(model.snapshot()))).toThrow(
      /structure/,
    );

    panel.x_axis = { kind: "signal", ref: null };
    expect(() => parseBakedSession(JSON.stringify(model.snapshot()))).toThrow(
      /structure/,
    );
  });

  it("rejects a foreign app", () => {
    const json = JSON.stringify({ ...emptySession(), app: "other" });
    expect(() => parseBakedSession(json)).toThrow(/app/);
  });

  it("rejects a schema version mismatch", () => {
    const json = JSON.stringify({
      ...emptySession(),
      schema_version: 1,
    });
    expect(() => parseBakedSession(json)).toThrow(/schema/);
  });

  it("rejects an invalid current-version session", () => {
    const incomplete: Record<string, unknown> = { ...emptySession() };
    delete incomplete.linked_time;
    expect(() => parseBakedSession(JSON.stringify(incomplete))).toThrow(
      /structure/,
    );

    const invalidPanel = emptySession();
    const tab = invalidPanel.tabs[0];
    if (tab === undefined) throw new Error("default tab is missing");
    tab.panels = [{} as never];
    expect(() => parseBakedSession(JSON.stringify(invalidPanel))).toThrow(
      /structure/,
    );

    const incompletePanel = new WorkspaceModel();
    const panel = incompletePanel.addPanelRow() as unknown as Record<
      string,
      unknown
    >;
    delete panel.stat_columns;
    expect(() =>
      parseBakedSession(JSON.stringify(incompletePanel.snapshot())),
    ).toThrow(/structure/);
  });

  it.each([
    ["color_slot", 0],
    ["color_slot", 9],
    ["width", -1],
    ["width", 5],
    ["opacity", -0.1],
    ["opacity", 1.1],
  ] as const)("rejects out-of-range override %s=%s", (field, value) => {
    const model = new WorkspaceModel();
    const panel = model.addPanelRow();
    panel.overrides = [
      {
        target_ref: null,
        target_selector: "*",
        color_slot: 1,
        dash: null,
        width: 1,
        opacity: 1,
        visible: true,
        [field]: value,
      },
    ];

    expect(() => parseBakedSession(JSON.stringify(model.snapshot()))).toThrow(
      /structure/,
    );
  });
});
