import { describe, expect, it } from "vitest";
import {
  COARSE_POINT_TARGET,
  SERIES_CHUNK_SIZE,
  TileRefinementController,
  type RefinementRequest,
} from "./tile-refinement";

interface PendingQuery {
  ids: readonly string[];
  target: number;
  resolve: () => void;
  reject: (error: unknown) => void;
}

function request(generation: number): RefinementRequest {
  return {
    panelId: "panel",
    generation,
    signalIds: Array.from({ length: 300 }, (_, index) => String(index)),
    window: { t0: 0, t1: 10 },
    target: 800,
  };
}

describe("TileRefinementController", () => {
  it("finishes every coarse chunk before starting fine chunks", async () => {
    const pending: PendingQuery[] = [];
    const events: string[] = [];
    const controller = new TileRefinementController((ids, _window, target) => {
      events.push(
        `${String(target)}:${String(ids[0])}-${String(ids[ids.length - 1])}`,
      );
      return new Promise<void>((resolve, reject) => {
        pending.push({ ids, target, resolve, reject });
      }).then(() => ({ requestId: "request", series: [] }));
    });
    const sink = {
      acceptCoarse: () => events.push("coarse"),
      acceptFine: () => events.push("fine"),
      fail: () => events.push("fail"),
    };

    const done = controller.begin(request(1), sink);
    expect(SERIES_CHUNK_SIZE).toBe(128);
    expect(events).toEqual([`64:0-127`]);
    expect(pending).toHaveLength(1);

    pending[0]?.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toContain("coarse");
    expect(events.filter((event) => event.startsWith("800:"))).toHaveLength(0);
    expect(events).toContain(`64:128-255`);
    pending[1]?.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toContain(`64:256-299`);
    pending[2]?.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual([
      `64:0-127`,
      "coarse",
      `64:128-255`,
      "coarse",
      `64:256-299`,
      "coarse",
      `800:0-127`,
    ]);
    expect(pending).toHaveLength(4);
    pending[3]?.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(pending).toHaveLength(5);
    pending[4]?.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(pending).toHaveLength(6);
    pending[5]?.resolve();
    await done;
    expect(events.filter((event) => event === "fine")).toHaveLength(3);
  });

  it("ignores stale responses and errors after a new generation starts", async () => {
    const pending: PendingQuery[] = [];
    const accepted: number[] = [];
    const controller = new TileRefinementController((ids, _window, target) =>
      new Promise<void>((resolve, reject) => {
        pending.push({ ids, target, resolve, reject });
      }).then(() => ({ requestId: "request", series: [] })),
    );
    const sink = {
      acceptCoarse: (generation: number) => accepted.push(generation),
      acceptFine: (generation: number) => accepted.push(generation),
      fail: (generation: number) => accepted.push(generation),
    };
    const first = controller.begin(request(1), sink);
    const second = controller.begin(
      { ...request(2), signalIds: ["new"] },
      sink,
    );
    pending[0]?.resolve();
    pending[1]?.resolve();
    await first;
    await Promise.resolve();
    pending[2]?.resolve();
    await second;
    expect(accepted).toEqual([2, 2]);
  });

  it("uses the coarse target when refinement is unnecessary", async () => {
    const targets: number[] = [];
    const controller = new TileRefinementController((ids, _window, target) => {
      targets.push(target);
      return Promise.resolve({ requestId: ids.join(","), series: [] });
    });
    await controller.begin(
      { ...request(3), target: COARSE_POINT_TARGET },
      {
        acceptCoarse: () => undefined,
        acceptFine: () => undefined,
        fail: () => undefined,
      },
    );
    expect(targets).toEqual([
      COARSE_POINT_TARGET,
      COARSE_POINT_TARGET,
      COARSE_POINT_TARGET,
    ]);
  });

  it("aborts the active generation before starting its successor", () => {
    let firstSignal: AbortSignal | undefined;
    const controller = new TileRefinementController(
      (_ids, _window, _target, signal) => {
        firstSignal ??= signal;
        return new Promise<never>(() => undefined);
      },
    );
    const sink = {
      acceptCoarse: () => undefined,
      acceptFine: () => undefined,
      fail: () => undefined,
    };
    controller.start(request(10), sink);
    controller.start({ ...request(11), signalIds: ["new"] }, sink);
    expect(firstSignal?.aborted).toBe(true);
    controller.cancelActive();
  });
});
