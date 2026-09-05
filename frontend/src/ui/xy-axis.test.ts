// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { Catalog } from "../app/catalog";
import { resolveLineBindings } from "../app/line-bindings";
import { queryLineGroups } from "../app/line-query";
import { line2dFamily } from "../app/line2d-family";
import { Line2DWindowCache } from "../app/tile-window-cache";
import { WorkspaceModel } from "../app/workspace";
import { parseBakedSession } from "../app/baked-session";
import type { DataPlane } from "../app/data-plane";
import type { Line2DResponse } from "../app/line-binary";
import type { SampleAxisSource } from "../generated/session";
import { showAxisPicker } from "./axis-picker";
import { bindAxisDrop } from "./axis-drop";
import { SIGNAL_DRAG_TYPE } from "./panel-shell";

const catalog = Catalog.build(
  ["one", "two"].flatMap((source) =>
    ["x", "y", "time"].map((channel) => ({
      signal_id: `${source}-${channel}`,
      source_id: source,
      source_key: source,
      local_path: channel,
      path: `${source}/${channel}`,
      unit: null,
      point_count: "3",
      t_min: 0,
      t_max: 2,
      last_value: null,
    })),
  ),
);
const ref = (source: string, channel: string) => ({
  source_key: source,
  channel,
});
const ys = ["two", "one"].map((source) => ({
  ref: ref(source, "y"),
  path: `${source}/y`,
}));
const bundle: SampleAxisSource = {
  kind: "bundle",
  refs: [ref("one", "x"), ref("two", "x")],
};

afterEach(() => {
  document.body.replaceChildren();
});

test("bundle pairing follows source identity despite reversed Y order", () => {
  expect(resolveLineBindings(bundle, ys, catalog)).toMatchObject({
    missing: [],
    groups: [
      { xId: "two-x", ids: ["two-y"] },
      { xId: "one-x", ids: ["one-y"] },
    ],
  });
  const shared = resolveLineBindings(
    { kind: "signal", ref: ref("one", "x") },
    [...ys, { ref: ref("one", "x"), path: "one/x" }],
    catalog,
  );
  expect(shared.groups).toEqual([
    { xId: "one-x", ids: ["two-y", "one-y", "one-x"] },
  ]);
});

test("missing and ambiguous X members prevent a partial bundle publication", () => {
  for (const refs of [
    [ref("one", "x")],
    [ref("one", "x"), ref("one", "time"), ref("two", "x")],
    [ref("one", "missing"), ref("two", "x")],
  ]) {
    const result = resolveLineBindings({ kind: "bundle", refs }, ys, catalog);
    expect(result.groups).toEqual([]);
    expect(result.missing).not.toHaveLength(0);
  }
});

function response(source: string, x: number[], y: number[]): Line2DResponse {
  return {
    requestId: source,
    level: 0,
    anchor: Float64Array.from(x.map((_, i) => i)),
    x: {
      signalId: `${source}-x`,
      signalPath: `${source}/x`,
      unit: null,
      values: Float64Array.from(x),
    },
    ys: [
      {
        signalId: `${source}-y`,
        signalPath: `${source}/y`,
        unit: null,
        values: Float64Array.from(y),
      },
    ],
  };
}

test("bundle queries preserve each run's coordinates through rendering, picking and cache accounting", async () => {
  const one = response("one", [1, 2], [3, 4]);
  const two = response("two", [8, 9, 7], [1, 2, 5]);
  const query = vi
    .fn<DataPlane["queryLine2D"]>()
    .mockResolvedValueOnce(one)
    .mockResolvedValueOnce(two);
  const result = await queryLineGroups(
    { queryLine2D: query } as unknown as DataPlane,
    [
      { xId: "one-x", ids: ["one-y"] },
      { xId: "two-x", ids: ["two-y"] },
    ],
    { t0: 0, t1: 2 },
    100,
    new AbortController().signal,
  );
  expect(result.ys[1]?.coordinates?.x.values).toBe(two.x.values);
  const prepared = line2dFamily({ kind: "signal", response: result }).prepare({
    series: [],
    window: { t0: 0, t1: 2 },
    axisStyle: "gutter",
    xLabel: null,
    yLabel: null,
  });
  const ranges = { x: { min: 0, max: 10 }, y: { min: 0, max: 10 } };
  const input = prepared.makeInput(ranges, []);
  expect(input.axes).toEqual({
    x: { label: "x" },
    y: { label: "y" },
    style: "gutter",
  });
  expect(Array.from(input.series[1]?.data ?? [])).toEqual([7, 1, 8, 2, 6, 5]);
  const layout = {
    ...ranges,
    xRange: ranges.x,
    yRange: ranges.y,
    plot: { x: 0, y: 0, width: 100, height: 100 },
  };
  const hit = prepared.plot.annotationAt(layout, { x: 70, y: 50 }, 12);
  expect(hit).toMatchObject({ path: "two/y", x: 7, anchor: 2, pinnedValue: 5 });
  const cursor = prepared.plot.cursorAt(layout, { x: 70, y: 50 }, 12);
  expect(cursor?.rows).toHaveLength(1);
  expect(cursor?.rows[0]).toMatchObject({ path: "two/y", value: 5 });
  const cache = new Line2DWindowCache();
  cache.store("panel", {
    idsKey: "pairs",
    window: { t0: 0, t1: 2 },
    pixelWidth: 100,
    requestedDevicePixels: 100,
    response: result,
  });
  expect(cache.retainedResourceUnitCount(new Set())).toBe(15);
});

test("failed or cancelled member queries cannot return a partial response", async () => {
  const query = vi
    .fn<DataPlane["queryLine2D"]>()
    .mockResolvedValueOnce(response("one", [1], [2]))
    .mockRejectedValueOnce(new Error("timebase mismatch"));
  await expect(
    queryLineGroups(
      { queryLine2D: query } as unknown as DataPlane,
      [
        { xId: "one-x", ids: ["one-y"] },
        { xId: "two-x", ids: ["two-y"] },
      ],
      { t0: 0, t1: 2 },
      100,
      new AbortController().signal,
    ),
  ).rejects.toThrow("timebase mismatch");
  const abort = new AbortController();
  abort.abort();
  await expect(
    queryLineGroups(
      { queryLine2D: query } as unknown as DataPlane,
      [{ xId: "x", ids: ["y"] }],
      { t0: 0, t1: 2 },
      100,
      abort.signal,
    ),
  ).rejects.toThrow();
  expect(query).toHaveBeenCalledTimes(2);
});

test("bundle bindings survive session serialization and reject empty bundles", () => {
  const workspace = new WorkspaceModel();
  const panel = workspace.addPanelRow();
  workspace.setPanelXAxis(panel.id, bundle);
  expect(
    parseBakedSession(JSON.stringify(workspace.snapshot())).tabs[0]?.panels[0]
      ?.x_axis,
  ).toEqual(bundle);
  panel.x_axis = { kind: "bundle", refs: [] };
  expect(() =>
    parseBakedSession(JSON.stringify(workspace.snapshot())),
  ).toThrow();
});

test("both axis pickers search all signals and channel bundles with keyboard selection", () => {
  const container = document.createElement("div");
  const anchor = document.createElement("button");
  container.append(anchor);
  document.body.append(container);
  const selectX = vi.fn();
  const addY = vi.fn();
  let close = showAxisPicker(
    container,
    anchor,
    "x",
    { kind: "time" },
    catalog,
    [],
    selectX,
    addY,
  );
  let search = container.querySelector("input") as HTMLInputElement;
  expect(document.activeElement).toBe(search);
  search.value = "two/time";
  search.dispatchEvent(new Event("input"));
  search.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
  expect(selectX).toHaveBeenCalledWith({
    kind: "signal",
    ref: ref("two", "time"),
  });
  expect(document.activeElement).toBe(anchor);
  close();
  close = showAxisPicker(
    container,
    anchor,
    "y",
    bundle,
    catalog,
    [],
    selectX,
    addY,
  );
  search = container.querySelector("input") as HTMLInputElement;
  search.value = "y · bundle";
  search.dispatchEvent(new Event("input"));
  search.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
  expect(addY).toHaveBeenCalledWith(["one/y", "two/y"]);
  close();
});

test("the X drop strip accepts a bundle without forwarding it as Y and cleans up", () => {
  const panel = document.createElement("div");
  document.body.append(panel);
  const select = vi.fn();
  const yDrop = vi.fn();
  const close = bindAxisDrop(
    panel,
    () => catalog,
    () => [],
    select,
  );
  panel.addEventListener("drop", yDrop);
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      getData: (type: string) =>
        type === SIGNAL_DRAG_TYPE
          ? JSON.stringify({ paths: ["one/x", "two/x"] })
          : "",
    },
  });
  panel.querySelector(".xy-drop-strip")?.dispatchEvent(event);
  expect(select).toHaveBeenCalledWith(bundle);
  expect(yDrop).not.toHaveBeenCalled();
  close();
  expect(panel.querySelector(".xy-drop-strip")).toBeNull();
});

test("C bundles match independently of X, reject missing/ambiguous members, and allow C=Y", () => {
  const color = {
    source: {
      kind: "bundle" as const,
      refs: [ref("one", "y"), ref("two", "y")],
    },
    range: null,
    label: null,
  };
  expect(resolveLineBindings(bundle, ys, catalog, color)).toMatchObject({
    missing: [],
    groups: [
      { xId: "two-x", colorIds: { "two-y": "two-y" } },
      { xId: "one-x", colorIds: { "one-y": "one-y" } },
    ],
  });
  for (const refs of [
    [ref("one", "time")],
    [ref("one", "x"), ref("one", "time"), ref("two", "x")],
  ]) {
    expect(
      resolveLineBindings(bundle, ys, catalog, {
        ...color,
        source: { kind: "bundle", refs },
      }),
    ).toMatchObject({ xId: null, groups: [] });
  }
  const shared = resolveLineBindings(bundle, ys, catalog, {
    ...color,
    source: { kind: "signal", ref: ref("one", "time") },
  });
  expect(
    shared.groups?.map((group) => Object.values(group.colorIds ?? {})),
  ).toEqual([["one-time"], ["one-time"]]);
  const timed = resolveLineBindings({ kind: "time" }, ys, catalog, {
    ...color,
    source: { kind: "time" },
  });
  expect(timed.groups?.every((group) => group.timeX && group.timeColor)).toBe(
    true,
  );
});

test("C columns are reduced with geometry and remain attributes instead of additional traces", async () => {
  const data = response("one", [3, 1, 2], [5, 6, 7]);
  const c = {
    ...data.x,
    signalId: "c",
    values: Float64Array.from([10, 99, 20]),
  };
  const query = vi
    .fn<DataPlane["queryLine2D"]>()
    .mockResolvedValue({ ...data, ys: [...data.ys, c] });
  const result = await queryLineGroups(
    { queryLine2D: query } as unknown as DataPlane,
    [{ xId: "one-x", ids: ["one-y"], colorIds: { "one-y": "c" } }],
    { t0: 0, t1: 2 },
    10,
    new AbortController().signal,
  );
  expect(query.mock.calls[0]?.[0].y_signal_ids).toEqual(["one-y", "c"]);
  expect(result.ys).toHaveLength(1);
  expect(result.ys[0]?.color?.values).toBe(c.values);
  expect(result.ys[0]?.values).toBe(data.ys[0]?.values);
  const time = await queryLineGroups(
    { queryLine2D: query } as unknown as DataPlane,
    [{ xId: "one-x", ids: ["one-y"], timeX: true, timeColor: true }],
    { t0: 0, t1: 2 },
    10,
    new AbortController().signal,
  );
  expect(time.x.values).toBe(data.anchor);
  expect(time.ys[0]?.color?.values).toBe(data.anchor);
});

test("C attributes survive save and clear without changing the categorical palette", () => {
  const workspace = new WorkspaceModel();
  const panel = workspace.addPanelRow();
  workspace.setPanelColorAxis(panel.id, {
    source: bundle,
    range: [0, 100],
    label: "temperature (K)",
  });
  const restored = parseBakedSession(JSON.stringify(workspace.snapshot()));
  expect(restored.tabs[0]?.panels[0]?.color_axis).toEqual(panel.color_axis);
  expect(() =>
    workspace.setPanelColorAxis(panel.id, {
      source: bundle,
      range: [1, 1],
      label: null,
    }),
  ).toThrow(/limits/);
  const categorical = panel.color_by;
  workspace.setPanelColorAxis(panel.id, null);
  expect(panel.color_axis).toBeNull();
  expect(panel.color_by).toBe(categorical);
});
