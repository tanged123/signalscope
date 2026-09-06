import { expect, test, vi } from "vitest";
import { BakedPlane } from "./data-plane";
import { seal } from "./envelope";
import { queryLineGroups } from "./line-query";
import { WorkspaceModel } from "./workspace";
import { parseBakedSession } from "./baked-session";

test("captured bundle pairs restore through BakedPlane without network access", async () => {
  const workspace = new WorkspaceModel();
  const panel = workspace.addPanelRow();
  workspace.setPanelXAxis(panel.id, {
    kind: "bundle",
    refs: [
      { source_key: "one", channel: "x" },
      { source_key: "two", channel: "x" },
    ],
  });
  const plane = new BakedPlane(
    seal({
      session_json: JSON.stringify(workspace.snapshot()),
      signals: ["1", "2", "3", "4"].map((id) => ({
        summary: {
          signal_id: id,
          source_id: id,
          source_key: id,
          path: `run/${id}`,
          local_path: id,
          unit: null,
          point_count: "2",
          t_min: 0,
          t_max: 1,
          last_value: null,
        },
        levels: [],
      })),
      line2d: [
        {
          x_signal_id: "1",
          y_signal_ids: ["2"],
          levels: [{ level: 0, anchor: [0, 1], x: [3, 1], ys: [[5, 6]] }],
        },
        {
          x_signal_id: "3",
          y_signal_ids: ["4"],
          levels: [{ level: 0, anchor: [0, 1], x: [7, 2], ys: [[8, 9]] }],
        },
      ],
    }),
  );
  const network = vi.fn(() => {
    throw new Error("unexpected network");
  });
  vi.stubGlobal("fetch", network);
  try {
    const restored = parseBakedSession(plane.bakedSessionJson);
    expect(restored.tabs[0]?.panels[0]?.x_axis).toEqual(panel.x_axis);
    const response = await queryLineGroups(
      plane,
      [
        { xId: "3", ids: ["4"] },
        { xId: "1", ids: ["2"] },
      ],
      { t0: 0, t1: 1 },
      100,
      new AbortController().signal,
    );
    expect(Array.from(response.ys[0]?.coordinates?.x.values ?? [])).toEqual([
      7, 2,
    ]);
    expect(Array.from(response.ys[1]?.coordinates?.x.values ?? [])).toEqual([
      3, 1,
    ]);
    expect(network).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
