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
    generation: 1,
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
    expect(first.key).toBe("7/0/10/1");
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
});
