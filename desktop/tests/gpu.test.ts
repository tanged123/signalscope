import { describe, expect, it } from "vitest";
import { classifyElectronGpu, type GpuDeviceInfo } from "../src/gpu";

const hardwareDevice: GpuDeviceInfo = {
  vendorId: 0x10de,
  deviceId: 0x2684,
  driverVendor: "NVIDIA",
  driverVersion: "555.1",
  description: "NVIDIA GeForce RTX 4090",
  active: true,
};

describe("Electron GPU classification", () => {
  it("keeps an active hardware adapter when unrelated features are disabled", () => {
    expect(
      classifyElectronGpu(
        { webgpu: "enabled", canvas_oop_rasterization: "disabled" },
        hardwareDevice,
        false,
      ),
    ).toEqual({
      softwareRendering: false,
      webGpuStatus: "enabled",
      fallbackReason: null,
    });
  });

  it("classifies explicit software mode as software", () => {
    expect(
      classifyElectronGpu({ webgpu: "enabled" }, hardwareDevice, true),
    ).toMatchObject({ softwareRendering: true, fallbackReason: null });
  });

  it.each([
    "SwiftShader",
    "llvmpipe",
    "Lavapipe",
    "Microsoft WARP",
    "software rasterizer",
  ])("classifies %s active-device evidence as software", (description) => {
    expect(
      classifyElectronGpu(
        { webgpu: "enabled" },
        { ...hardwareDevice, description },
        false,
      ),
    ).toMatchObject({ softwareRendering: true, fallbackReason: null });
  });

  it.each(["disabled", "unavailable"])(
    "reports WebGPU %s as unsupported rather than software",
    (webgpu) => {
      expect(classifyElectronGpu({ webgpu }, hardwareDevice, false)).toEqual({
        softwareRendering: false,
        webGpuStatus: webgpu,
        fallbackReason: `webgpu ${webgpu}`,
      });
    },
  );

  it("reports missing adapter identity as unsupported", () => {
    expect(
      classifyElectronGpu({ webgpu: "enabled" }, undefined, false),
    ).toMatchObject({
      softwareRendering: false,
      fallbackReason: "adapter identity unavailable",
    });
  });
});
