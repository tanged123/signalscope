import { describe, expect, it, vi } from "vitest";
import { PanelRenderTargets, PANEL_MSAA_SAMPLE_COUNT } from "./render-targets";

function device() {
  const texture = {
    createView: vi.fn(() => ({ kind: "msaa-view" })),
    destroy: vi.fn(),
  } as unknown as GPUTexture;
  const createTexture = vi.fn(() => texture);
  return {
    device: { createTexture } as unknown as GPUDevice,
    texture,
    createTexture,
  };
}

function context() {
  const swapchain = {
    createView: vi.fn(() => ({ kind: "swapchain-view" })),
  } as unknown as GPUTexture;
  return {
    context: {
      getCurrentTexture: vi.fn(() => swapchain),
    } as unknown as GPUCanvasContext,
    swapchain,
  };
}

describe("PanelRenderTargets", () => {
  it("creates one stable four-sample attachment and resolves the current surface", () => {
    const gpu = device();
    const surface = context();
    const targets = new PanelRenderTargets();
    targets.configure(gpu.device, surface.context, "bgra8unorm");
    targets.resize(320, 180);

    expect(gpu.createTexture).toHaveBeenCalledWith({
      label: "signalscope-panel-msaa",
      size: { width: 320, height: 180, depthOrArrayLayers: 1 },
      format: "bgra8unorm",
      sampleCount: PANEL_MSAA_SAMPLE_COUNT,
      usage: 0x0010,
    });
    expect(targets.frame()).toEqual({
      swapchain: { kind: "swapchain-view" },
      msaa: { kind: "msaa-view" },
    });
  });

  it("does not recreate unchanged sizes and destroys replaced surfaces", () => {
    const gpu = device();
    const surface = context();
    const targets = new PanelRenderTargets();
    targets.configure(gpu.device, surface.context, "bgra8unorm");
    targets.resize(100, 50);
    targets.resize(100, 50);
    expect(gpu.createTexture).toHaveBeenCalledTimes(1);
    targets.resize(101, 50);
    expect(gpu.texture.destroy).toHaveBeenCalledTimes(1);
    targets.destroy();
    expect(gpu.texture.destroy).toHaveBeenCalledTimes(2);
  });

  it("recreates the attachment when the device or format changes", () => {
    const first = device();
    const second = device();
    const surface = context();
    const targets = new PanelRenderTargets();
    targets.configure(first.device, surface.context, "bgra8unorm");
    targets.resize(20, 20);
    targets.configure(second.device, surface.context, "rgba8unorm");
    targets.resize(20, 20);
    expect(first.texture.destroy).toHaveBeenCalledTimes(1);
    expect(second.createTexture).toHaveBeenCalledTimes(1);
  });
});
