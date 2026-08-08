import { describe, expect, it, vi } from "vitest";
import { GpuArena } from "./arena";
import { GpuResidency, type ResidencyTile } from "./residency";

const MiB = 1024 * 1024;

function tile(id: string, sourceStart: string, bytes = 256): ResidencyTile {
  return {
    signalId: id,
    level: 0,
    sourceStart,
    sourceEnd: String(Number(sourceStart) + 2),
    origin: 0,
    seriesSlot: Number(id),
    coarse: false,
    points: {
      count: bytes / 16,
      bytes: new Uint8Array(bytes),
      forceBreakFirst: false,
    },
  };
}

function residency() {
  const device = {
    createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
  } as unknown as GPUDevice;
  const queue = { writeBuffer: vi.fn() } as unknown as GPUQueue;
  const arena = new GpuArena(device, queue, {
    maxStorageBufferBindingSize: 16 * MiB,
    maxBufferSize: 16 * MiB,
  });
  return new GpuResidency(arena, { budgetBytes: 768 });
}

describe("GpuResidency", () => {
  it("keys uploads by exact tile identity and retains metadata", () => {
    const store = residency();
    const first = store.upload(tile("7", "10"));
    const again = store.upload(tile("7", "10"));
    expect(again).toBe(first);
    expect(first.key).toBe("7/0/10");
    expect(first.points.size).toBe(256);
  });

  it("evicts least-recently-used non-visible tiles before pinned coarse tiles", () => {
    const store = residency();
    const coarse = store.upload({ ...tile("1", "0"), coarse: true });
    store.pin(coarse.key, true);
    const old = store.upload(tile("2", "0"));
    store.setVisible(old.key, false);
    const current = store.upload(tile("3", "0"));
    store.setVisible(current.key, true);
    store.upload(tile("4", "0"));
    expect(store.has(coarse.key)).toBe(true);
    expect(store.has(old.key)).toBe(false);
  });

  it("rejects a fine batch before admitting a partial subset", () => {
    const store = residency();
    const coarse = store.uploadBatch([
      { ...tile("1", "0"), coarse: true },
      { ...tile("2", "0"), coarse: true },
    ]);
    expect(coarse).toHaveLength(2);
    expect(() =>
      store.uploadBatch([tile("1", "2", 512), tile("2", "2", 512)]),
    ).toThrow("GPU residency batch exceeds panel budget");
    expect(store.visible().map((entry) => entry.key)).toEqual([
      "1/0/0",
      "2/0/0",
    ]);
  });

  it("keeps identity stable across acquisition generations", () => {
    const store = residency();
    const first = store.stage(4, [tile("7", "10")]);
    const second = store.stage(5, [tile("7", "10")]);
    expect(second[0]).toBe(first[0]);
    expect(second[0]?.key).toBe("7/0/10");
    expect(store.select(5, ["7/0/10"])).toEqual(second);
  });

  it("stages fine tiles without disturbing a complete coarse selection", () => {
    const store = residency();
    const coarse = tile("1", "0");
    const coarseResident = store.stage(1, [{ ...coarse, coarse: true }]);
    store.select(
      1,
      coarseResident.map((entry) => entry.key),
    );
    expect(() =>
      store.stage(2, [tile("1", "2", 512), tile("2", "0", 512)]),
    ).toThrow("GPU residency batch exceeds panel budget");
    expect(store.visible().map((entry) => entry.key)).toEqual(["1/0/0"]);
    expect(store.has("1/0/2")).toBe(false);
    expect(store.has("2/0/0")).toBe(false);
  });

  it("reports selected point coverage without scanning the point stream", () => {
    const store = residency();
    const resident = store.stage(1, [
      { ...tile("1", "0", 32), points: points(0, 10) },
    ]);
    store.select(
      1,
      resident.map((entry) => entry.key),
    );
    expect(store.covers(["1/0/0"], 2, 8)).toBe(true);
    expect(store.covers(["1/0/0"], -1, 8)).toBe(false);
  });
});

function points(first: number, last: number): ResidencyTile["points"] {
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  view.setFloat32(0, first, true);
  view.setFloat32(16, last, true);
  return { count: 2, bytes, forceBreakFirst: false };
}
