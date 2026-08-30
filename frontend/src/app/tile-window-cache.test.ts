import { describe, expect, test } from "vitest";
import type { EnvelopeBin } from "../generated/protocol";
import { binColumnsFromWire, sliceColumns } from "./bin-columns";
import { TileWindowCache, type CachedPanelTiles } from "./tile-window-cache";

function bin(t0: number, t1: number): EnvelopeBin {
  return {
    t0,
    t1,
    first: t0,
    last: t1,
    min: t0,
    max: t1,
    sum: t0,
    sum_sq: t0 * t0,
    finite_count: "1",
    sample_count: "1",
    has_gap: false,
  };
}

function entry(count = 20, level = 2): CachedPanelTiles {
  const bins = binColumnsFromWire(
    Array.from({ length: count }, (_, index) => bin(index, index + 0.5)),
  );
  return {
    response: {
      requestId: "padded",
      series: [
        {
          signalId: "7",
          signalPath: "run/value",
          unit: "V",
          level,
          bins,
        },
      ],
    },
    window: { t0: 0, t1: count },
    pixelWidth: 10,
    requestedDevicePixels: 8,
    idsKey: "7",
  };
}

test("padWindow aligns equal-span adjacent viewports", () => {
  const first = TileWindowCache.padWindow(0.25, 1.25);
  const second = TileWindowCache.padWindow(0.75, 1.75);
  expect(first).toEqual({ t0: 0, t1: 2 });
  expect(second).toEqual(first);
  expect(TileWindowCache.padWindow(0.25, 1.25)).toEqual(first);
});

describe("requestPixelWidth", () => {
  test("scales physical pixels by the padding ratio", () => {
    const visible = { t0: 0, t1: 100 };
    const padded = TileWindowCache.padWindow(visible.t0, visible.t1);
    const paddedSpan = padded.t1 - padded.t0;
    expect(paddedSpan).toBeGreaterThanOrEqual(2 * 100);

    const requested = TileWindowCache.requestPixelWidth(
      800,
      2,
      visible,
      padded,
    );
    expect(requested).toBe(Math.ceil(Math.ceil(800 * 2) * (paddedSpan / 100)));
  });

  test("never returns less than the physical panel width", () => {
    const visible = { t0: 0, t1: 100 };
    expect(
      TileWindowCache.requestPixelWidth(800, 2, visible, {
        t0: 0,
        t1: 100,
      }),
    ).toBe(1600);
  });

  test("falls back to physical width on a degenerate span", () => {
    const visible = { t0: 5, t1: 5 };
    expect(
      TileWindowCache.requestPixelWidth(800, 2, visible, {
        t0: 0,
        t1: 16,
      }),
    ).toBe(1600);
  });
});

test("lookup classifies current, stale, and uncovered aggregate responses", () => {
  const cache = new TileWindowCache();
  const cached = entry();
  cache.store("panel", cached);

  expect(cache.lookup("panel", "7", { t0: 5, t1: 15 }, 8).kind).toBe("current");
  expect(cache.lookup("panel", "7", { t0: 8, t1: 12 }, 8)).toMatchObject({
    kind: "stale",
    response: cached.response,
  });
  expect(cache.lookup("panel", "7", { t0: -1, t1: 10 }, 8)).toEqual({
    kind: "miss",
  });
});

test("level-zero responses remain current at any covered zoom", () => {
  const cache = new TileWindowCache();
  const cached = { ...entry(20, 0), requestedDevicePixels: 2 };
  cache.store("panel", cached);

  expect(cache.lookup("panel", "7", { t0: 0, t1: 19 }, 2_000)).toMatchObject({
    kind: "current",
    response: cached.response,
  });
});

test("retains a wide overview when a deep detail becomes current", () => {
  const cache = new TileWindowCache();
  const overview = {
    ...entry(100, 4),
    response: { ...entry(100, 4).response, requestId: "overview" },
    window: { t0: 0, t1: 100 },
  };
  const detail = {
    ...entry(20, 0),
    response: { ...entry(20, 0).response, requestId: "detail" },
    window: { t0: 40, t1: 60 },
  };

  cache.store("panel", overview);
  cache.store("panel", detail);

  expect(cache.get("panel")?.response.requestId).toBe("detail");
  expect(cache.covering("panel", "7", { t0: 10, t1: 90 })?.requestId).toBe(
    "overview",
  );
  expect(cache.covering("panel", "7", { t0: 45, t1: 55 })?.requestId).toBe(
    "detail",
  );
  expect(cache.coveringCurrent("panel", { t0: 10, t1: 90 })?.requestId).toBe(
    "overview",
  );
});

test("retains the latest detail when widening an overview", () => {
  const cache = new TileWindowCache();
  const overview = { ...entry(80, 4), window: { t0: 0, t1: 80 } };
  const detail = {
    ...entry(20, 0),
    response: { ...entry(20, 0).response, requestId: "detail" },
    window: { t0: 30, t1: 50 },
  };
  const wider = {
    ...entry(100, 5),
    response: { ...entry(100, 5).response, requestId: "wider" },
    window: { t0: 0, t1: 100 },
  };

  cache.store("panel", overview);
  cache.store("panel", detail);
  cache.store("panel", wider);

  expect(cache.covering("panel", "7", { t0: 35, t1: 45 })?.requestId).toBe(
    "detail",
  );
});

test("lookup rejects mismatched keys and invalidates entries", () => {
  const cache = new TileWindowCache();
  cache.store("panel", entry());
  expect(cache.lookup("panel", "8", { t0: 5, t1: 10 }, 8)).toEqual({
    kind: "miss",
  });
  expect(cache.lookup("missing", "7", { t0: 5, t1: 10 }, 8)).toEqual({
    kind: "miss",
  });
  expect(cache.get("missing")).toBeNull();
  cache.invalidate("panel");
  expect(cache.get("panel")).toBeNull();
});

test("binCount accounts for retained active and inactive panel data", () => {
  const cache = new TileWindowCache();
  cache.store("active", entry(20));
  cache.store("active", {
    ...entry(5),
    window: { t0: 3, t1: 8 },
  });
  cache.store("inactive", entry(12));
  cache.store("inactive", {
    ...entry(5),
    window: { t0: 3, t1: 8 },
  });

  expect(cache.binCount()).toBe(42);
  expect(cache.binCount(new Set(["active"]))).toBe(17);
  expect(cache.retainedBinCount(new Set(["active"]))).toBe(37);
});

test("sliceColumns preserves typed-array views", () => {
  const columns = binColumnsFromWire([bin(0, 0), bin(1, 1), bin(2, 2)]);
  const sliced = sliceColumns(columns, 1, 3);
  expect(sliced.t0.buffer).toBe(columns.t0.buffer);
  expect(Array.from(sliced.t0)).toEqual([1, 2]);
});
