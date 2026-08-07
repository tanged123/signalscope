import { describe, expect, it, vi } from "vitest";
import {
  GpuArena,
  arenaPageBytes,
  GPU_BUFFER_COPY_DST,
  GPU_BUFFER_STORAGE,
} from "./arena";

const MiB = 1024 * 1024;

function device() {
  const createBuffer = vi.fn((descriptor: GPUBufferDescriptor) => ({
    descriptor,
  }));
  return {
    device: { createBuffer } as unknown as GPUDevice,
    createBuffer,
  };
}

describe("GpuArena", () => {
  it("chooses a limit-aware page size", () => {
    expect(
      arenaPageBytes({
        maxStorageBufferBindingSize: 128 * MiB,
        maxBufferSize: 256 * MiB,
      }),
    ).toBe(64 * MiB);
    expect(
      arenaPageBytes({
        maxStorageBufferBindingSize: 32 * MiB,
        maxBufferSize: 32 * MiB,
      }),
    ).toBe(32 * MiB);
  });

  it("allocates aligned first-fit slices and coalesces released blocks", () => {
    const gpu = device();
    const arena = new GpuArena(
      gpu.device,
      { writeBuffer: vi.fn() } as unknown as GPUQueue,
      { maxStorageBufferBindingSize: 16 * MiB, maxBufferSize: 16 * MiB },
    );
    const first = arena.allocate(100);
    const second = arena.allocate(200);
    expect(first).toEqual({ page: 0, offset: 0, size: 256 });
    expect(second).toEqual({ page: 0, offset: 256, size: 256 });
    arena.release(first);
    const reused = arena.allocate(128);
    expect(reused).toEqual(first);
    arena.release(second);
    arena.release(reused);
    expect(arena.freeBytes(0)).toBe(arena.pageBytes);
  });

  it("creates storage copy-destination pages and writes once", () => {
    const gpu = device();
    const writeBuffer = vi.fn();
    const queue = { writeBuffer } as unknown as GPUQueue;
    const arena = new GpuArena(gpu.device, queue, {
      maxStorageBufferBindingSize: 16 * MiB,
      maxBufferSize: 16 * MiB,
    });
    const slice = arena.allocate(4);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    arena.write(slice, bytes);
    expect(gpu.createBuffer).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: GPU_BUFFER_STORAGE | GPU_BUFFER_COPY_DST,
      }),
    );
    expect(writeBuffer).toHaveBeenCalledTimes(1);
  });

  it("rejects allocations larger than one page", () => {
    const arena = new GpuArena(
      device().device,
      { writeBuffer: vi.fn() } as unknown as GPUQueue,
      { maxStorageBufferBindingSize: 16 * MiB, maxBufferSize: 16 * MiB },
    );
    expect(() => arena.allocate(16 * MiB + 1)).toThrow(/one page/i);
  });
});
