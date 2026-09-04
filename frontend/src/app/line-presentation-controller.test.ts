// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ColumnarTileResponse } from "./bin-columns";
import { binColumnsFromWire } from "./bin-columns";
import type { DataPlane } from "./data-plane";
import type { Line2DResponse } from "./line-binary";
import {
  LinePresentationController,
  type LinePresentationCallbacks,
} from "./line-presentation-controller";
import type { PanelState } from "../generated/session";

const prepareTimeTiles = vi.hoisted(() => vi.fn());
const prepareSignalXLine = vi.hoisted(() => vi.fn());

vi.mock("../render/time-adapter", () => ({ prepareTimeTiles }));
vi.mock("../render/signal-x-adapter", () => ({ prepareSignalXLine }));

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function tileResponse(signalId = "1"): ColumnarTileResponse {
  return {
    requestId: `tiles-${signalId}`,
    series: [
      {
        signalId,
        signalPath: "run/value",
        unit: "V",
        level: 0,
        bins: binColumnsFromWire([
          {
            t0: 0,
            t1: 1,
            first: 1,
            last: 2,
            min: 1,
            max: 2,
            sum: 3,
            sum_sq: 5,
            finite_count: "2",
            sample_count: "2",
            has_gap: false,
          },
        ]),
      },
    ],
  };
}

function coarseTileResponse(signalId = "1"): ColumnarTileResponse {
  const response = tileResponse(signalId);
  return {
    ...response,
    series: response.series.map((series) => ({
      ...series,
      level: 2,
      bins: binColumnsFromWire(
        Array.from({ length: 20 }, (_, index) => ({
          t0: index,
          t1: index + 5,
          first: 1,
          last: 2,
          min: 1,
          max: 2,
          sum: 3,
          sum_sq: 5,
          finite_count: "2",
          sample_count: "2",
          has_gap: false,
        })),
      ),
    })),
  };
}

type ControllerProbe = {
  controller: LinePresentationController;
  queryTiles: ReturnType<typeof vi.fn<DataPlane["queryTiles"]>>;
  queryLine2D: ReturnType<typeof vi.fn<DataPlane["queryLine2D"]>>;
  querySamples: ReturnType<typeof vi.fn<DataPlane["querySamples"]>>;
  panels: PanelState[];
  windows: Map<string, { t0: number; t1: number }>;
  panelSignalIds: ReturnType<
    typeof vi.fn<LinePresentationCallbacks["signalIds"]>
  >;
  render: ReturnType<typeof vi.fn<LinePresentationCallbacks["render"]>>;
  onPlan: ReturnType<typeof vi.fn>;
  onRender: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
};

function panel(id: string): PanelState {
  return { id, x_axis: { kind: "time" } } as PanelState;
}

function controllerProbe(
  queryTiles: DataPlane["queryTiles"],
  panelIds = ["panel-1"],
): ControllerProbe {
  const panels = panelIds.map(panel);
  const windows = new Map(
    panelIds.map((id) => [id, { t0: 0, t1: 5 }] as const),
  );
  const querySamples = vi.fn<DataPlane["querySamples"]>(() =>
    Promise.resolve({ request_id: "samples", series: [] }),
  );
  const queryTilesMock = vi.fn<DataPlane["queryTiles"]>(queryTiles);
  const queryLine2D = vi.fn<DataPlane["queryLine2D"]>();
  const panelSignalIds = vi.fn<LinePresentationCallbacks["signalIds"]>(
    (current) => ({
      ids: [current.id === "panel-2" ? "2" : "1"],
      xId: null,
      missing: [],
    }),
  );
  const render = vi.fn<LinePresentationCallbacks["render"]>(() => 1.5);
  const onPlan = vi.fn();
  const onRender = vi.fn();
  const onError = vi.fn();
  const plane = {
    queryTiles: queryTilesMock,
    queryLine2D,
    querySamples,
  } as unknown as DataPlane;
  const controller = new LinePresentationController(plane, {
    panels: () => panels,
    workspaceWidth: () => 1000,
    panelWidth: () => 1000,
    signalIds: panelSignalIds,
    windowFor: (current) => windows.get(current.id) ?? { t0: 0, t1: 5 },
    defaultWindow: () => ({ t0: 0, t1: 5 }),
    gpu: () => null,
    render,
    onPlan,
    onRender,
    onError,
  });
  return {
    controller,
    queryTiles: queryTilesMock,
    queryLine2D,
    querySamples,
    panels,
    windows,
    panelSignalIds,
    render,
    onPlan,
    onRender,
    onError,
  };
}

describe("LinePresentationController", () => {
  beforeEach(() => {
    prepareTimeTiles.mockReset();
    prepareSignalXLine.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not issue an uncapped sample request for live refresh", async () => {
    const queryTiles = vi.fn<DataPlane["queryTiles"]>(() =>
      Promise.resolve({ requestId: "tiles", series: [] }),
    );
    const probe = controllerProbe(queryTiles);

    await probe.controller.refresh();

    expect(probe.querySamples).not.toHaveBeenCalled();
    expect(probe.queryTiles).toHaveBeenCalledOnce();
  });

  it("routes an explicit signal X through the paired Line2D endpoint", async () => {
    const probe = controllerProbe(() =>
      Promise.resolve({ requestId: "unused", series: [] }),
    );
    const firstPanel = probe.panels[0];
    if (firstPanel === undefined) throw new Error("missing test panel");
    firstPanel.x_axis = {
      kind: "signal",
      ref: { source_key: "source", channel: "x" },
    };
    probe.panelSignalIds.mockReturnValue({
      ids: ["2", "3"],
      xId: "1",
      missing: [],
    });
    const response: Line2DResponse = {
      requestId: "line",
      level: 0,
      anchor: new Float64Array([0, 1]),
      x: {
        signalId: "1",
        signalPath: "run/x",
        unit: null,
        values: new Float64Array([10, 20]),
      },
      ys: [
        {
          signalId: "2",
          signalPath: "run/y",
          unit: null,
          values: new Float64Array([30, 40]),
        },
      ],
    };
    probe.queryLine2D.mockResolvedValue(response);

    await probe.controller.refresh();

    expect(probe.queryTiles).not.toHaveBeenCalled();
    expect(probe.queryLine2D).toHaveBeenCalledWith(
      expect.objectContaining({ x_signal_id: "1", y_signal_ids: ["2", "3"] }),
    );
    expect([...probe.controller.responses()]).toEqual([
      { kind: "signal", response },
    ]);

    probe.panelSignalIds.mockReturnValue({
      ids: ["3", "2"],
      xId: "1",
      missing: [],
    });
    await probe.controller.refresh();
    expect(probe.queryLine2D).toHaveBeenLastCalledWith(
      expect.objectContaining({ y_signal_ids: ["3", "2"] }),
    );
    expect(probe.queryLine2D).toHaveBeenCalledTimes(2);
  });

  it("keeps a Line2D endpoint failure scoped to its panel", async () => {
    const probe = controllerProbe(
      () => Promise.resolve({ requestId: "time", series: [] }),
      ["panel-1", "panel-2"],
    );
    const xRef = { source_key: "source", channel: "x" };
    const firstPanel = probe.panels[0];
    if (firstPanel === undefined) throw new Error("missing test panel");
    firstPanel.x_axis = { kind: "signal", ref: xRef };
    probe.panelSignalIds.mockImplementation((current) =>
      current.id === "panel-1"
        ? { ids: ["2"], xId: "1", missing: [] }
        : { ids: ["3"], xId: null, missing: [] },
    );
    const mismatch = new Error("signals do not share a timebase");
    probe.queryLine2D.mockRejectedValue(mismatch);

    await probe.controller.refresh();

    expect(probe.queryLine2D).toHaveBeenCalledOnce();
    expect(probe.queryTiles).toHaveBeenCalledOnce();
    const errorFor = probe.render.mock.calls[0]?.[3];
    expect(errorFor?.("panel-1")).toBe(mismatch.message);
    expect(errorFor?.("panel-2")).toBeNull();
    expect(probe.onError).toHaveBeenCalledWith(mismatch);
    expect([...probe.controller.responses()]).toEqual([
      { kind: "time", response: { requestId: "time", series: [] } },
    ]);
  });

  it("reuses a dense raw window without a second plane query", async () => {
    const queryTiles = vi.fn<DataPlane["queryTiles"]>(() =>
      Promise.resolve({
        requestId: "tiles",
        series: [
          {
            signalId: "1",
            signalPath: "run/value",
            unit: null,
            level: 0,
            bins: binColumnsFromWire(
              Array.from({ length: 12 }, (_, index) => ({
                t0: index,
                t1: index,
                first: index,
                last: index,
                min: index,
                max: index,
                sum: index,
                sum_sq: index * index,
                finite_count: "1",
                sample_count: "1",
                has_gap: false,
              })),
            ),
          },
        ],
      }),
    );
    const probe = controllerProbe(queryTiles);

    await probe.controller.refresh();
    await probe.controller.refresh();

    expect(probe.queryTiles).toHaveBeenCalledOnce();
    expect(probe.onError).not.toHaveBeenCalled();
  });

  it("keeps stale drawable tiles while refinement is pending", async () => {
    const pending = deferred<ColumnarTileResponse>();
    const queryTiles = vi
      .fn<DataPlane["queryTiles"]>()
      .mockResolvedValueOnce(coarseTileResponse())
      .mockReturnValueOnce(pending.promise);
    const probe = controllerProbe(queryTiles);

    await probe.controller.refresh();
    const stale = [...probe.controller.responses()][0];
    expect(stale).toBeDefined();
    probe.windows.set("panel-1", { t0: 8, t1: 12 });

    const refresh = probe.controller.refresh();
    await Promise.resolve();

    expect(probe.queryTiles).toHaveBeenCalledTimes(2);
    expect([...probe.controller.responses()][0]).toBe(stale);
    expect(probe.render).toHaveBeenCalledOnce();

    pending.resolve(tileResponse());
    await refresh;
  });

  it("discards a superseded response before the queued refresh publishes", async () => {
    const first = deferred<ColumnarTileResponse>();
    const second = deferred<ColumnarTileResponse>();
    const queryTiles = vi
      .fn<DataPlane["queryTiles"]>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const probe = controllerProbe(queryTiles);

    const refresh = probe.controller.refresh();
    await Promise.resolve();
    const queued = probe.controller.refresh();
    first.resolve(tileResponse("first"));
    await Promise.resolve();
    await Promise.resolve();

    expect(probe.render).not.toHaveBeenCalled();
    expect([...probe.controller.responses()]).toHaveLength(0);

    second.resolve(tileResponse("second"));
    await Promise.all([refresh, queued]);

    expect(probe.render).toHaveBeenCalledOnce();
    expect([...probe.controller.responses()][0]?.response.requestId).toBe(
      "tiles-second",
    );
  });

  it("does not publish a response after its panel is invalidated", async () => {
    const pending = deferred<ColumnarTileResponse>();
    const probe = controllerProbe(() => pending.promise);

    const refresh = probe.controller.refresh();
    await Promise.resolve();
    probe.controller.invalidate("panel-1");
    pending.resolve(tileResponse());
    await refresh;

    expect([...probe.controller.responses()]).toHaveLength(0);
    expect(probe.render).not.toHaveBeenCalled();
  });

  it("prewarms every replacement before publishing the map", async () => {
    const order: string[] = [];
    prepareTimeTiles.mockImplementation(() => order.push("prewarm"));
    const queryTiles = vi.fn(
      (request: Parameters<DataPlane["queryTiles"]>[0]) =>
        Promise.resolve(tileResponse(request.signal_ids[0] ?? "1")),
    );
    const probe = controllerProbe(queryTiles, ["panel-1", "panel-2"]);
    probe.render.mockImplementation(() => {
      order.push("render");
      return 0;
    });

    await probe.controller.refresh();

    expect(prepareTimeTiles).toHaveBeenCalledTimes(2);
    expect(order).toEqual(["prewarm", "prewarm", "render"]);
  });

  it("prewarms a signal-X replacement before publishing it", async () => {
    const probe = controllerProbe(() =>
      Promise.resolve({ requestId: "unused", series: [] }),
    );
    const firstPanel = probe.panels[0];
    if (firstPanel === undefined) throw new Error("missing test panel");
    firstPanel.x_axis = {
      kind: "signal",
      ref: { source_key: "source", channel: "x" },
    };
    probe.panelSignalIds.mockReturnValue({
      ids: ["2"],
      xId: "1",
      missing: [],
    });
    const response: Line2DResponse = {
      requestId: "line",
      level: 0,
      anchor: new Float64Array([0, 1]),
      x: {
        signalId: "1",
        signalPath: "run/x",
        unit: null,
        values: new Float64Array([10, 20]),
      },
      ys: [
        {
          signalId: "2",
          signalPath: "run/y",
          unit: null,
          values: new Float64Array([30, 40]),
        },
      ],
    };
    probe.queryLine2D.mockResolvedValue(response);
    prepareSignalXLine.mockImplementation(() => {
      expect([...probe.controller.responses()]).toHaveLength(0);
    });

    await probe.controller.refresh();

    expect(prepareSignalXLine).toHaveBeenCalledWith(response, { t0: 0, t1: 5 });
    expect([...probe.controller.responses()]).toEqual([
      { kind: "signal", response },
    ]);
    expect(probe.render).toHaveBeenCalledOnce();
  });

  it("reports preparation failures without publishing a replacement", async () => {
    const preparationError = new Error("feed allocation failed");
    const queryTiles = vi
      .fn<DataPlane["queryTiles"]>()
      .mockResolvedValueOnce(tileResponse("current"))
      .mockResolvedValueOnce(tileResponse("replacement"));
    const probe = controllerProbe(queryTiles);

    await probe.controller.refresh();
    const current = [...probe.controller.responses()][0];
    prepareTimeTiles.mockImplementation(() => {
      throw preparationError;
    });
    probe.windows.set("panel-1", { t0: 10, t1: 90 });

    await probe.controller.refresh();

    expect(probe.onError).toHaveBeenCalledWith(preparationError);
    expect([...probe.controller.responses()][0]).toBe(current);
    expect(probe.render).toHaveBeenCalledOnce();
  });

  it("uniformly lowers density instead of rejecting more than 3,000 series", async () => {
    const queryTiles = vi.fn<DataPlane["queryTiles"]>(() =>
      Promise.resolve(tileResponse()),
    );
    const probe = controllerProbe(queryTiles);
    probe.panelSignalIds.mockReturnValue({
      ids: Array.from({ length: 3001 }, (_, index) => String(index)),
      xId: null,
      missing: [],
    });

    await probe.controller.refresh();

    expect(probe.onError).not.toHaveBeenCalled();
    expect(probe.queryTiles).toHaveBeenCalledOnce();
    expect(probe.queryTiles.mock.calls[0]?.[0].pixel_width).toBeGreaterThan(0);
    expect(probe.queryTiles.mock.calls[0]?.[0].pixel_width).toBeLessThan(2048);
    expect(probe.render).toHaveBeenCalledOnce();
  });

  it("publishes retained overview coverage before zoom-out refinement", async () => {
    const queryTiles = vi
      .fn<DataPlane["queryTiles"]>()
      .mockResolvedValueOnce(coarseTileResponse("overview"))
      .mockResolvedValueOnce(tileResponse("detail"));
    const probe = controllerProbe(queryTiles);
    probe.windows.set("panel-1", { t0: 0, t1: 100 });

    await probe.controller.refresh();
    probe.windows.set("panel-1", { t0: 40, t1: 60 });
    await probe.controller.refresh();
    expect([...probe.controller.responses()][0]?.response.requestId).toBe(
      "tiles-detail",
    );

    probe.windows.set("panel-1", { t0: 10, t1: 90 });
    probe.controller.publishCachedCoverage();

    expect([...probe.controller.responses()][0]?.response.requestId).toBe(
      "tiles-overview",
    );
  });

  it("reports synchronous render errors without retrying", () => {
    const error = new Error("ChartGPU render failed");
    const queryTiles = vi.fn<DataPlane["queryTiles"]>(() =>
      Promise.resolve({ requestId: "tiles", series: [] }),
    );
    const probe = controllerProbe(queryTiles);
    probe.render.mockImplementation(() => {
      throw error;
    });

    expect(() => probe.controller.render()).not.toThrow();
    expect(probe.render).toHaveBeenCalledOnce();
    expect(probe.onError).toHaveBeenCalledWith(error);
    expect(probe.onRender).not.toHaveBeenCalled();
  });

  it("schedules render and refresh work after a resize", () => {
    const requestAnimationFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
    const setTimeout = vi.spyOn(window, "setTimeout");
    const queryTiles = vi.fn<DataPlane["queryTiles"]>(() =>
      Promise.resolve({ requestId: "tiles", series: [] }),
    );
    const probe = controllerProbe(queryTiles);

    probe.controller.resized();

    expect(requestAnimationFrame).toHaveBeenCalledOnce();
    expect(setTimeout).toHaveBeenCalledOnce();
    expect(setTimeout.mock.calls[0]?.[1]).toBe(50);
  });
});
