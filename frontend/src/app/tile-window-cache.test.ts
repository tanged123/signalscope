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

test("sliceColumns preserves typed-array views", () => {
  const columns = binColumnsFromWire([bin(0, 0), bin(1, 1), bin(2, 2)]);
  const sliced = sliceColumns(columns, 1, 3);
  expect(sliced.t0.buffer).toBe(columns.t0.buffer);
  expect(Array.from(sliced.t0)).toEqual([1, 2]);
});
