import { createPipelineCache } from "@chartgpu/chartgpu";

export interface GpuFailure {
  kind: "device-lost" | "uncaptured-error";
  message: string;
}

export interface GpuContext {
  adapter: GPUAdapter;
  device: GPUDevice;
  pipelineCache: unknown;
  register(host: { needsRender(): boolean; renderFrame(): void }): () => void;
  onFailure(callback: (failure: GpuFailure) => void): () => void;
  dispose(): void;
}

interface DeviceLostInfo {
  reason: string;
  message: string;
}

interface DeviceEvents {
  lost: Promise<DeviceLostInfo>;
  addEventListener(type: string, listener: EventListener): void;
}

const ADAPTER_RETRY_DELAYS_MS = [0, 100, 250, 500] as const;

async function requestAdapterAndDevice(
  gpu: GPU,
): Promise<{ adapter: GPUAdapter; device: GPUDevice } | null> {
  const requests = [
    () => gpu.requestAdapter({ powerPreference: "high-performance" }),
    () => gpu.requestAdapter(),
  ];
  for (const requestAdapter of requests) {
    try {
      const adapter = await requestAdapter();
      if (adapter === null) continue;
      const device = (await adapter.requestDevice()) as unknown as GPUDevice;
      return { adapter, device };
    } catch {
      continue;
    }
  }
  return null;
}

export async function acquireGpuContext(): Promise<GpuContext | null> {
  try {
    const gpu = navigator.gpu;
    if (gpu === undefined) return null;
    let requested: Awaited<ReturnType<typeof requestAdapterAndDevice>> = null;
    for (const delay of ADAPTER_RETRY_DELAYS_MS) {
      if (delay > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
      requested = await requestAdapterAndDevice(gpu);
      if (requested !== null) break;
    }
    if (requested === null) return null;
    const { adapter, device } = requested;
    const deviceEvents = device as unknown as DeviceEvents;
    const hosts = new Set<{ needsRender(): boolean; renderFrame(): void }>();
    const failedHosts = new WeakSet();
    const failureListeners = new Set<(failure: GpuFailure) => void>();
    let frame: number | null = null;
    let lost = false;
    let disposed = false;
    const page = typeof window === "undefined" ? null : window;

    const notifyFailure = (failure: GpuFailure): void => {
      for (const listener of failureListeners) listener(failure);
    };

    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      lost = true;
      hosts.clear();
      failureListeners.clear();
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
      page?.removeEventListener("pagehide", dispose);
      try {
        device.destroy();
      } catch {
        // Device loss may race page teardown.
      }
    };
    page?.addEventListener("pagehide", dispose);

    void deviceEvents.lost.then((info) => {
      if (info.reason === "destroyed" || lost) return;
      lost = true;
      hosts.clear();
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
      notifyFailure({
        kind: "device-lost",
        message: info.message || "WebGPU device lost",
      });
    });

    deviceEvents.addEventListener("uncapturederror", (event) => {
      event.preventDefault();
      const error = (event as unknown as { error?: { message?: string } })
        .error;
      notifyFailure({
        kind: "uncaptured-error",
        message: error?.message || "WebGPU uncaptured error",
      });
    });

    const tick = (): void => {
      frame = null;
      for (const host of hosts) {
        try {
          if (host.needsRender()) host.renderFrame();
          failedHosts.delete(host);
        } catch (error) {
          if (!failedHosts.has(host)) {
            failedHosts.add(host);
            notifyFailure({
              kind: "uncaptured-error",
              message:
                error instanceof Error ? error.message : "WebGPU render failed",
            });
          }
        }
      }
      if (hosts.size > 0) frame = requestAnimationFrame(tick);
    };

    return {
      adapter,
      device,
      pipelineCache: createPipelineCache(device),
      register(host) {
        if (lost) return () => {};
        hosts.add(host);
        if (frame === null) frame = requestAnimationFrame(tick);
        return () => {
          hosts.delete(host);
          if (hosts.size === 0 && frame !== null) {
            cancelAnimationFrame(frame);
            frame = null;
          }
        };
      },
      onFailure(callback) {
        failureListeners.add(callback);
        return () => {
          failureListeners.delete(callback);
        };
      },
      dispose,
    };
  } catch {
    return null;
  }
}
