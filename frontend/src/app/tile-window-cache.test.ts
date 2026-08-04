import { expect, test } from "vitest";
import type { EnvelopeBin } from "../generated/protocol";
import { binColumnsFromWire, sliceColumns } from "./bin-columns";
import { TileWindowCache, type CachedPanelTiles } from "./tile-window-cache";

function bin(index: number): EnvelopeBin {
  return {
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
  };
}

function entry(count = 20): CachedPanelTiles {
  const bins = binColumnsFromWire(
    Array.from({ length: count }, (_, index) => bin(index)),
  );
  return {
    response: {
      requestId: "padded",
      series: [
        {
          signalId: "7",
          signalPath: "run/value",
          unit: "V",
          level: 2,
          bins,
        },
      ],
    },
    window: { t0: 0, t1: count - 1 },
    pixelWidth: 10,
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

test("slice returns a zero-copy padded-window view", () => {
  const cache = new TileWindowCache();
  const cached = entry();
  cache.store("panel", cached);
  const sliced = cache.slice("panel", "7", 10, 5, 10);
  expect(sliced?.requestId).toBe("padded");
  expect(Array.from(sliced?.series[0]?.bins.t0 ?? [])).toEqual([
    4, 5, 6, 7, 8, 9, 10, 11,
  ]);
  expect(sliced?.series[0]?.bins.t0.buffer).toBe(
    cached.response.series[0]?.bins.t0.buffer,
  );
});

test("slice rejects mismatched keys, uncovered windows, and over-dense views", () => {
  const cache = new TileWindowCache();
  cache.store("panel", entry());
  expect(cache.slice("panel", "8", 10, 5, 10)).toBeNull();
  expect(cache.slice("panel", "7", 10, -1, 10)).toBeNull();
  expect(cache.slice("panel", "7", 2, 5, 10)).toBeNull();
  expect(cache.get("missing")).toBeNull();
  cache.invalidate("panel");
  expect(cache.get("panel")).toBeNull();
});

test("sliceColumns preserves typed-array views", () => {
  const columns = binColumnsFromWire([bin(0), bin(1), bin(2)]);
  const sliced = sliceColumns(columns, 1, 3);
  expect(sliced.t0.buffer).toBe(columns.t0.buffer);
  expect(Array.from(sliced.t0)).toEqual([1, 2]);
});
