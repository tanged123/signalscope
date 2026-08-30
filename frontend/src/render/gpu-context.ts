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
}

interface DeviceLostInfo {
  reason: string;
  message: string;
}

interface DeviceEvents {
  lost: Promise<DeviceLostInfo>;
  addEventListener(type: string, listener: EventListener): void;
}

export async function acquireGpuContext(): Promise<GpuContext | null> {
  try {
    const gpu = navigator.gpu;
    if (gpu === undefined) return null;
    const adapter =
      (await gpu.requestAdapter({ powerPreference: "high-performance" })) ??
      (await gpu.requestAdapter());
    if (adapter === null) return null;
    const device = (await adapter.requestDevice()) as unknown as GPUDevice;
    const deviceEvents = device as unknown as DeviceEvents;
    const hosts = new Set<{ needsRender(): boolean; renderFrame(): void }>();
    const failureListeners = new Set<(failure: GpuFailure) => void>();
    let frame: number | null = null;
    let lost = false;

    const notifyFailure = (failure: GpuFailure): void => {
      for (const listener of failureListeners) listener(failure);
    };

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
        if (host.needsRender()) host.renderFrame();
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
    };
  } catch {
    return null;
  }
}
