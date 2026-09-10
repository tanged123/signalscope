import { describe, expect, it } from "vitest";
import { Catalog } from "./catalog";
import { resolvePanel } from "./resolution";
import { WorkspaceModel } from "./workspace";

function fixture() {
  const workspace = new WorkspaceModel();
  const panel = workspace.addPanelRow();
  const refs = ["temperature", "pressure", "flow"].map((channel) => ({
    source_key: "run",
    channel,
  }));
  const catalog = Catalog.build(
    refs.map((ref, index) => ({
      signal_id: String(index + 1),
      source_id: "1",
      source_key: ref.source_key,
      local_path: ref.channel,
      path: `run/${ref.channel}`,
      unit: null,
      point_count: "1",
      t_min: 0,
      t_max: 1,
      last_value: null,
    })),
  );
  for (const ref of refs) workspace.addSeriesRef(panel.id, ref);
  workspace.addSelectorOverride(panel.id, "*", {
    color_slot: 3,
    dash: "dot",
    width: 2,
    visible: false,
  });
  const resolve = () => resolvePanel(catalog, panel, []);
  return { workspace, panel, refs, catalog, resolve };
}

describe("bulk plot signal actions", () => {
  it("keeps focus, visibility, opacity and line properties independent across bulk actions", () => {
    const { workspace, panel, refs, resolve } = fixture();
    const styles = resolve().map(({ hue, dash, width }) => ({
      hue,
      dash,
      width,
    }));
    workspace.applySeriesAction(panel.id, refs, "select");
    expect(resolve().every((series) => series.focused && !series.visible)).toBe(
      true,
    );
    workspace.applySeriesAction(panel.id, refs, "dim");
    expect(
      resolve().every(
        (series) =>
          series.focused &&
          !series.visible &&
          series.opacity === panel.ghost_opacity,
      ),
    ).toBe(true);
    workspace.applySeriesAction(panel.id, refs, "show");
    expect(
      resolve().every(
        (series) => series.focused && series.visible && series.opacity < 1,
      ),
    ).toBe(true);
    workspace.applySeriesAction(panel.id, refs, "hide");
    const first = refs[0];
    if (first === undefined) throw new Error("Missing first signal");
    workspace.toggleSeriesVisible(panel.id, first);
    expect(resolve().map((series) => series.visible)).toEqual([
      true,
      false,
      false,
    ]);
    expect(
      resolve().map(({ hue, dash, width }) => ({ hue, dash, width })),
    ).toEqual(styles);
    workspace.applySeriesAction(panel.id, refs, "clear");
    expect(
      resolve().every((series) => !series.focused && series.opacity < 1),
    ).toBe(true);
  });

  it("undims focused and non-focused signals and survives session restoration", () => {
    const { workspace, panel, refs, catalog, resolve } = fixture();
    workspace.setGhostMode(panel.id, "ghost");
    workspace.applySeriesAction(panel.id, refs.slice(0, 1), "select");
    workspace.applySeriesAction(panel.id, refs, "dim");
    workspace.applySeriesAction(panel.id, refs, "undim");
    expect(resolve().map((series) => series.opacity)).toEqual([1, 1, 1]);
    expect(resolve().map((series) => series.focused)).toEqual([
      true,
      false,
      false,
    ]);
    expect(resolve().every((series) => !series.visible)).toBe(true);
    const restored = new WorkspaceModel(structuredClone(workspace.snapshot()));
    const restoredPanel = restored.panel(panel.id);
    if (restoredPanel === undefined) throw new Error("Missing restored panel");
    expect(resolvePanel(catalog, restoredPanel, [])).toEqual(resolve());
  });

  it("publishes once per action and bounds overrides through repeated bulk toggles", () => {
    const { workspace, panel, refs } = fixture();
    const revision = workspace.resolutionRevision();
    workspace.applySeriesAction(panel.id, refs, "hide");
    expect(workspace.resolutionRevision()).toBe(revision + 1);
    const count = panel.overrides.length;
    for (let index = 0; index < 10; index++) {
      workspace.applySeriesAction(panel.id, refs, "show");
      workspace.applySeriesAction(panel.id, refs, "hide");
    }
    expect(panel.overrides).toHaveLength(count);
  });
});
