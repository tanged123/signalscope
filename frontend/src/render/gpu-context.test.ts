import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireGpuContext } from "./gpu-context";

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

function installDevice() {
  const loss = deferred<{ reason: string; message: string }>();
  const listeners = new Map<string, EventListener>();
  const device = {
    queue: {},
    lost: loss.promise,
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      listeners.set(type, listener);
    }),
  };
  Object.defineProperty(navigator, "gpu", {
    configurable: true,
    value: {
      requestAdapter: vi.fn(() =>
        Promise.resolve({
          requestDevice: vi.fn(() => Promise.resolve(device)),
        }),
      ),
    },
  });
  return { device, loss, listeners };
}

describe("acquireGpuContext", () => {
  afterEach(() => {
    Object.defineProperty(navigator, "gpu", {
      configurable: true,
      value: undefined,
    });
    vi.restoreAllMocks();
  });

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
            requestDevice: vi.fn(() =>
              Promise.resolve({
                queue: {},
                lost: new Promise(() => {}),
                addEventListener: vi.fn(),
              }),
            ),
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

  it("retries adapter acquisition without a power preference", async () => {
    const { device } = installDevice();
    const adapter = { requestDevice: vi.fn(() => Promise.resolve(device)) };
    const requestAdapter = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(adapter);
    Object.defineProperty(navigator, "gpu", {
      configurable: true,
      value: { requestAdapter },
    });

    expect(await acquireGpuContext()).not.toBeNull();
    expect(requestAdapter).toHaveBeenNthCalledWith(1, {
      powerPreference: "high-performance",
    });
    expect(requestAdapter).toHaveBeenNthCalledWith(2);
  });

  it("retries after device acquisition fails", async () => {
    const { device } = installDevice();
    const requestAdapter = vi
      .fn()
      .mockResolvedValueOnce({
        requestDevice: vi.fn(() => Promise.reject(new Error("not ready"))),
      })
      .mockResolvedValueOnce({
        requestDevice: vi.fn(() => Promise.resolve(device)),
      });
    Object.defineProperty(navigator, "gpu", {
      configurable: true,
      value: { requestAdapter },
    });

    expect(await acquireGpuContext()).not.toBeNull();
    expect(requestAdapter).toHaveBeenCalledTimes(2);
  });

  it("stops the shared loop and notifies once after device loss", async () => {
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
    const { loss } = installDevice();

    const gpu = await acquireGpuContext();
    expect(gpu).not.toBeNull();
    const onFailure = vi.fn();
    gpu?.onFailure(onFailure);
    const unregister = gpu?.register({
      needsRender: () => true,
      renderFrame: vi.fn(),
    });
    expect(requestAnimationFrame).toHaveBeenCalledOnce();

    loss.resolve({ reason: "unknown", message: "adapter reset" });
    await Promise.resolve();

    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledWith({
      kind: "device-lost",
      message: "adapter reset",
    });
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    const requestsBefore = requestAnimationFrame.mock.calls.length;
    const afterLoss = gpu?.register({
      needsRender: () => true,
      renderFrame: vi.fn(),
    });
    expect(requestAnimationFrame).toHaveBeenCalledTimes(requestsBefore);
    afterLoss?.();
    unregister?.();
  });

  it("reports uncaptured errors without stopping a healthy loop", async () => {
    const requestAnimationFrame = vi.fn(() => 1);
    const cancelAnimationFrame = vi.fn();
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: requestAnimationFrame,
    });
    Object.defineProperty(globalThis, "cancelAnimationFrame", {
      configurable: true,
      value: cancelAnimationFrame,
    });
    const { listeners } = installDevice();
    const gpu = await acquireGpuContext();
    expect(gpu).not.toBeNull();
    const onFailure = vi.fn();
    gpu?.onFailure(onFailure);
    const unregister = gpu?.register({
      needsRender: () => true,
      renderFrame: vi.fn(),
    });
    const preventDefault = vi.fn();
    const event = {
      error: { message: "shader failed" },
      preventDefault,
    } as unknown as Event & { error: { message: string } };

    listeners.get("uncapturederror")?.(event);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledWith({
      kind: "uncaptured-error",
      message: "shader failed",
    });
    expect(cancelAnimationFrame).not.toHaveBeenCalled();
    unregister?.();
  });
});
