import { createPipelineCache } from "@chartgpu/chartgpu";

export interface GpuContext {
  adapter: GPUAdapter;
  device: GPUDevice;
  pipelineCache: unknown;
  register(host: { needsRender(): boolean; renderFrame(): void }): () => void;
}

export async function acquireGpuContext(): Promise<GpuContext | null> {
  try {
    const adapter = await navigator.gpu?.requestAdapter({
      powerPreference: "high-performance",
    });
    if (adapter === null || adapter === undefined) return null;
    const device = await adapter.requestDevice();
    const hosts = new Set<{ needsRender(): boolean; renderFrame(): void }>();
    let frame: number | null = null;

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
    };
  } catch {
    return null;
  }
}
