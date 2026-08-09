import { describe, expect, it, vi } from "vitest";
import {
  MIN_STORAGE_BINDING_BYTES,
  SCAN_WORKGROUP_SIZE,
  requestGpuDevice,
  validateLimits,
} from "./capabilities";

function limits(
  overrides: Partial<GPUSupportedLimits> = {},
): GPUSupportedLimits {
  return {
    maxStorageBuffersPerShaderStage: 8,
    maxComputeWorkgroupSizeX: SCAN_WORKGROUP_SIZE,
    maxComputeWorkgroupSizeY: 1,
    maxComputeWorkgroupSizeZ: 1,
    maxComputeInvocationsPerWorkgroup: SCAN_WORKGROUP_SIZE,
    maxStorageBufferBindingSize: MIN_STORAGE_BINDING_BYTES,
    maxBufferSize: MIN_STORAGE_BINDING_BYTES * 2,
    ...overrides,
  } as GPUSupportedLimits;
}

function gpuWith(
  adapter: Partial<GPUAdapter> = {},
  device: Partial<GPUDevice> = {},
): GPU {
  return {
    requestAdapter: vi.fn().mockResolvedValue({
      limits: limits(),
      requestDevice: vi.fn().mockResolvedValue(device),
      ...adapter,
    }),
    getPreferredCanvasFormat: vi.fn().mockReturnValue("bgra8unorm"),
  } as unknown as GPU;
}

describe("requestGpuDevice", () => {
  it("requires the five storage buffers used by the renderer and picker", () => {
    expect(validateLimits(limits({ maxStorageBuffersPerShaderStage: 4 }))).toBe(
      "WebGPU requires five storage buffers per shader stage",
    );
  });

  it("reports an unavailable navigator GPU", async () => {
    await expect(requestGpuDevice(undefined)).resolves.toEqual({
      supported: false,
      capability: "navigator.gpu",
      reason: "WebGPU is unavailable",
    });
  });

  it("reports a missing adapter", async () => {
    const gpu = {
      requestAdapter: vi.fn().mockResolvedValue(null),
    } as unknown as GPU;
    await expect(requestGpuDevice(gpu)).resolves.toEqual({
      supported: false,
      capability: "requestAdapter",
      reason: "WebGPU adapter unavailable",
    });
  });

  it("tries the default adapter after a missing high-performance adapter", async () => {
    const device = {
      lost: new Promise<GPUDeviceLostInfo>(() => undefined),
    };
    const requestAdapter = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        limits: limits(),
        requestDevice: vi.fn().mockResolvedValue(device),
      });
    const gpu = {
      requestAdapter,
      getPreferredCanvasFormat: vi.fn().mockReturnValue("bgra8unorm"),
    } as unknown as GPU;
    await expect(requestGpuDevice(gpu)).resolves.toMatchObject({
      supported: true,
    });
    expect(requestAdapter).toHaveBeenNthCalledWith(1, {
      powerPreference: "high-performance",
    });
    expect(requestAdapter).toHaveBeenNthCalledWith(2);
  });

  it.each([
    ["storage buffers", { maxStorageBuffersPerShaderStage: 3 }],
    ["workgroup size", { maxComputeWorkgroupSizeX: 128 }],
    ["workgroup invocations", { maxComputeInvocationsPerWorkgroup: 128 }],
    [
      "storage binding",
      { maxStorageBufferBindingSize: MIN_STORAGE_BINDING_BYTES - 1 },
    ],
  ])("rejects insufficient %s", async (_, override) => {
    await expect(
      requestGpuDevice(gpuWith({ limits: limits(override) })),
    ).resolves.toMatchObject({
      supported: false,
      capability: "adapter.limits",
    });
  });

  it("returns a device after preferred-format negotiation", async () => {
    const device = { lost: new Promise<GPUDeviceLostInfo>(() => undefined) };
    const result = await requestGpuDevice(gpuWith({}, device));
    expect(result).toMatchObject({ supported: true, format: "bgra8unorm" });
    if (result.supported) expect(result.device).toBe(device);
  });

  it("turns device request failures into data", async () => {
    const requestDevice = vi.fn().mockRejectedValueOnce(new Error("denied"));
    const gpu = {
      requestAdapter: vi.fn().mockResolvedValue({
        limits: limits(),
        requestDevice,
      }),
      getPreferredCanvasFormat: vi.fn().mockReturnValue("bgra8unorm"),
    } as unknown as GPU;
    await expect(requestGpuDevice(gpu)).resolves.toEqual({
      supported: false,
      capability: "requestDevice",
      reason: "WebGPU device request failed",
    });
  });
});
