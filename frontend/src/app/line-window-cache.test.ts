import { describe, expect, test } from "vitest";
import type { Line2DColumn, Line2DResponse } from "./line-binary";
import { Line2DWindowCache } from "./tile-window-cache";

function response(
  rows: number,
  level = 1,
  yCount = 2,
  step = 1,
  requestId = "line",
): Line2DResponse {
  const anchor = Float64Array.from(
    { length: rows },
    (_, index) => index * step,
  );
  const column = (index: number): Line2DColumn => ({
    signalId: String(index + 1),
    signalPath: index === 0 ? "run/x" : `run/y${String(index)}`,
    unit: null,
    values: Float64Array.from({ length: rows }, (_, row) => row + index),
  });
  return {
    requestId,
    level,
    anchor,
    x: column(0),
    ys: Array.from({ length: yCount }, (_, index) => column(index + 1)),
  };
}

function entry(
  rows: number,
  window: { t0: number; t1: number },
  options: {
    level?: number;
    yCount?: number;
    step?: number;
    requestId?: string;
  } = {},
) {
  return {
    response: response(
      rows,
      options.level,
      options.yCount,
      options.step,
      options.requestId,
    ),
    window,
    pixelWidth: 100,
    requestedDevicePixels: 100,
    idsKey: "x:1/y:2,3",
  };
}

describe("Line2DWindowCache", () => {
  test("classifies paired responses as current, stale, or uncovered", () => {
    const cache = new Line2DWindowCache();
    const cached = entry(101, { t0: 0, t1: 100 });
    cache.store("panel", cached);

    expect(
      cache.lookup("panel", cached.idsKey, { t0: 10, t1: 90 }, 20).kind,
    ).toBe("current");
    expect(
      cache.lookup("panel", cached.idsKey, { t0: 10, t1: 20 }, 100),
    ).toMatchObject({
      kind: "stale",
      response: cached.response,
    });
    expect(
      cache.lookup("panel", cached.idsKey, { t0: -1, t1: 20 }, 20),
    ).toEqual({
      kind: "miss",
    });
  });

  test("uses shared anchor span and density for resolution", () => {
    const cache = new Line2DWindowCache();
    const sparse = entry(5, { t0: 0, t1: 100 }, { step: 25 });
    cache.store("panel", sparse);

    expect(
      cache.lookup("panel", sparse.idsKey, { t0: 0, t1: 100 }, 5),
    ).toMatchObject({
      kind: "stale",
    });
    expect(
      cache.lookup("panel", sparse.idsKey, { t0: 0, t1: 100 }, 1).kind,
    ).toBe("current");
  });

  test("retains a wide overview and the latest detail for covered windows", () => {
    const cache = new Line2DWindowCache();
    const overview = entry(101, { t0: 0, t1: 100 }, { requestId: "overview" });
    const detail = entry(
      21,
      { t0: 40, t1: 60 },
      { level: 0, requestId: "detail" },
    );
    cache.store("panel", overview);
    cache.store("panel", detail);

    expect(cache.get("panel")?.response.requestId).toBe("detail");
    expect(
      cache.covering("panel", overview.idsKey, { t0: 10, t1: 90 })?.requestId,
    ).toBe("overview");
    expect(
      cache.covering("panel", overview.idsKey, { t0: 45, t1: 55 })?.requestId,
    ).toBe("detail");
    expect(cache.coveringCurrent("panel", { t0: 10, t1: 90 })?.requestId).toBe(
      "overview",
    );
  });

  test("separates X/Y identity keys", () => {
    const cache = new Line2DWindowCache();
    const cached = entry(20, { t0: 0, t1: 20 });
    cache.store("panel", cached);

    expect(cache.lookup("panel", "x:1/y:9", { t0: 2, t1: 10 }, 4)).toEqual({
      kind: "miss",
    });
  });

  test("counts retained anchor, X, and Y resource units and invalidates panels", () => {
    const cache = new Line2DWindowCache();
    cache.store("panel", entry(10, { t0: 0, t1: 10 }, { yCount: 2 }));
    cache.store(
      "panel",
      entry(4, { t0: 3, t1: 7 }, { yCount: 3, requestId: "detail" }),
    );
    cache.store("other", entry(5, { t0: 0, t1: 5 }, { yCount: 1 }));

    expect(cache.resourceUnitCount()).toBe(10 * 4 + 4 * 5 + 5 * 3);
    expect(cache.resourceUnitCount(new Set(["other"]))).toBe(10 * 4 + 4 * 5);
    expect(cache.retainedResourceUnitCount(new Set(["panel"]))).toBe(40 + 15);

    cache.invalidate("panel");
    expect(cache.get("panel")).toBeNull();
    expect(cache.resourceUnitCount()).toBe(15);
  });
});
