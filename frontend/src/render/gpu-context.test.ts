import { describe, expect, it, vi } from "vitest";
import { acquireGpuContext } from "./gpu-context";

describe("acquireGpuContext", () => {
  it("returns null when WebGPU is absent", async () => {
    expect(await acquireGpuContext()).toBeNull();
  });

  it("drives registered hosts from one animation frame loop", async () => {
    const frames: FrameRequestCallback[] = [];
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const cancelAnimationFrame = vi.fn();
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: requestAnimationFrame,
    });
    Object.defineProperty(globalThis, "cancelAnimationFrame", {
      configurable: true,
      value: cancelAnimationFrame,
    });
    Object.defineProperty(navigator, "gpu", {
      configurable: true,
      value: {
        requestAdapter: vi.fn(() =>
          Promise.resolve({
            requestDevice: vi.fn(() => Promise.resolve({ queue: {} })),
          }),
        ),
      },
    });

    const gpu = await acquireGpuContext();
    expect(gpu).not.toBeNull();
    let dirty = true;
    const renderFrame = vi.fn(() => {
      dirty = false;
    });
    const unregister = gpu?.register({
      needsRender: () => dirty,
      renderFrame,
    });
    frames.shift()?.(0);
    expect(renderFrame).toHaveBeenCalledTimes(1);
    expect(requestAnimationFrame).toHaveBeenCalled();
    unregister?.();
  });
});
