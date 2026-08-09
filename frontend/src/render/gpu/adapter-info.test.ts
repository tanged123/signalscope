import { describe, expect, it } from "vitest";
import {
  classifyGpuEvidence,
  gpuEvidenceFromNative,
  type GpuEvidence,
} from "./adapter-info";

function evidence(overrides: Partial<GpuEvidence> = {}): GpuEvidence {
  return {
    electronVersion: "43.0.0",
    chromiumVersion: "130.0.6723.44",
    adapterVendor: "0x10de",
    adapterArchitecture: "",
    adapterDevice: "0x2684",
    adapterDescription: "NVIDIA GeForce RTX 4090",
    softwareRendering: false,
    fallbackReason: null,
    limits: { maxBufferSize: 1 },
    ...overrides,
  };
}

describe("classifyGpuEvidence", () => {
  it("accepts a complete hardware adapter", () => {
    expect(classifyGpuEvidence(evidence())).toBe("hardware");
  });

  it.each([
    "SwiftShader",
    "llvmpipe",
    "lavapipe",
    "Microsoft WARP",
    "software rasterizer",
  ])("rejects %s as software rendering", (description) => {
    expect(
      classifyGpuEvidence(evidence({ adapterDescription: description })),
    ).toBe("software");
  });

  it("trusts an explicit native software flag", () => {
    expect(
      classifyGpuEvidence(
        evidence({ softwareRendering: true, fallbackReason: null }),
      ),
    ).toBe("software");
  });

  it("keeps incomplete adapter evidence unsupported", () => {
    expect(
      classifyGpuEvidence(
        evidence({
          adapterVendor: "",
          adapterDevice: "",
          adapterDescription: "",
          fallbackReason: "adapter identity unavailable",
        }),
      ),
    ).toBe("unsupported");
  });

  it("normalizes Electron's selected software adapter", () => {
    const normalized = gpuEvidenceFromNative({
      electron: "43.0.0",
      chromium: "150.0.0",
      softwareRendering: true,
      adapter: {
        vendor: "Google",
        device: "0x8e",
        description: "SwiftShader Device",
      },
    });
    expect(normalized).toMatchObject({
      electronVersion: "43.0.0",
      adapterDescription: "SwiftShader Device",
      fallbackReason: null,
    });
    expect(classifyGpuEvidence(normalized)).toBe("software");
  });

  it("preserves an unsupported WebGPU status from native evidence", () => {
    const normalized = gpuEvidenceFromNative({
      electron: "43.2.0",
      chromium: "150.0.0",
      webGpuStatus: "unavailable",
      fallbackReason: "webgpu unavailable",
      adapter: {
        vendor: "NVIDIA",
        device: "0x2684",
        description: "NVIDIA GeForce RTX 4090",
      },
    });
    expect(normalized.fallbackReason).toBe("webgpu unavailable");
    expect(classifyGpuEvidence(normalized)).toBe("unsupported");
  });
});
