import { describe, expect, it, vi } from "vitest";
import { MIN_STORAGE_BINDING_BYTES, SCAN_WORKGROUP_SIZE } from "./capabilities";
import { GpuRuntime } from "./runtime";

function mockGpu(device: GPUDevice): GPU {
  const limits = {
    maxStorageBuffersPerShaderStage: 8,
    maxComputeWorkgroupSizeX: SCAN_WORKGROUP_SIZE,
    maxComputeInvocationsPerWorkgroup: SCAN_WORKGROUP_SIZE,
    maxStorageBufferBindingSize: MIN_STORAGE_BINDING_BYTES,
    maxBufferSize: MIN_STORAGE_BINDING_BYTES * 2,
  };
  return {
    requestAdapter: vi.fn().mockResolvedValue({
      limits,
      requestDevice: vi.fn().mockResolvedValue(device),
    }),
    getPreferredCanvasFormat: vi.fn().mockReturnValue("bgra8unorm"),
  } as unknown as GPU;
}

function deviceMock() {
  let lose: (info: GPUDeviceLostInfo) => void = () => undefined;
  const device = {
    lost: new Promise<GPUDeviceLostInfo>((resolve) => {
      lose = resolve;
    }),
    queue: { submit: vi.fn() },
    createShaderModule: vi.fn(
      (descriptor: GPUShaderModuleDescriptor) => descriptor,
    ),
    addEventListener: vi.fn(),
  } as unknown as GPUDevice;
  return { device, lose };
}

describe("GpuRuntime", () => {
  it("caches shaders and pipelines by explicit keys", async () => {
    const mocked = deviceMock();
    const runtimeResult = await GpuRuntime.create(mockGpu(mocked.device));
    expect(runtimeResult.supported).toBe(true);
    if (!runtimeResult.supported) return;
    const first = runtimeResult.runtime.shader("line", "shader");
    const second = runtimeResult.runtime.shader("line", "other");
    expect(first).toBe(second);
    const pipeline = { id: "pipeline" } as unknown as GPURenderPipeline;
    const create = vi.fn(() => pipeline);
    expect(runtimeResult.runtime.renderPipeline("line", create)).toBe(pipeline);
    expect(runtimeResult.runtime.renderPipeline("line", create)).toBe(pipeline);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("stops panels and reports device loss", async () => {
    const mocked = deviceMock();
    const runtimeResult = await GpuRuntime.create(mockGpu(mocked.device));
    expect(runtimeResult.supported).toBe(true);
    if (!runtimeResult.supported) return;
    const panel = {
      id: "panel",
      encode: vi.fn(),
      deviceLost: vi.fn(),
      deviceRestored: vi.fn(),
    };
    const errors: unknown[] = [];
    runtimeResult.runtime.onError((error) => errors.push(error));
    runtimeResult.runtime.register(panel);
    mocked.lose({ reason: "destroyed", message: "lost" } as GPUDeviceLostInfo);
    await Promise.resolve();
    expect(panel.deviceLost).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([{ kind: "lost", message: "lost" }]);
  });

  it("reacquires one device and restores registered panels", async () => {
    const first = deviceMock();
    const second = deviceMock();
    const limits = {
      maxStorageBuffersPerShaderStage: 8,
      maxComputeWorkgroupSizeX: SCAN_WORKGROUP_SIZE,
      maxComputeInvocationsPerWorkgroup: SCAN_WORKGROUP_SIZE,
      maxStorageBufferBindingSize: MIN_STORAGE_BINDING_BYTES,
      maxBufferSize: MIN_STORAGE_BINDING_BYTES * 2,
    };
    const gpu = {
      requestAdapter: vi
        .fn()
        .mockResolvedValueOnce({
          limits,
          requestDevice: vi.fn().mockResolvedValue(first.device),
        })
        .mockResolvedValueOnce({
          limits,
          requestDevice: vi.fn().mockResolvedValue(second.device),
        }),
      getPreferredCanvasFormat: vi.fn().mockReturnValue("bgra8unorm"),
    } as unknown as GPU;
    const runtimeResult = await GpuRuntime.create(gpu);
    expect(runtimeResult.supported).toBe(true);
    if (!runtimeResult.supported) return;
    const panel = {
      id: "panel",
      encode: vi.fn(),
      deviceLost: vi.fn(),
      deviceRestored: vi.fn(),
    };
    const restored = vi.fn();
    runtimeResult.runtime.onRestored(restored);
    runtimeResult.runtime.register(panel);
    first.lose({ reason: "destroyed", message: "lost" } as GPUDeviceLostInfo);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(panel.deviceLost).toHaveBeenCalledTimes(1);
    expect(panel.deviceRestored).toHaveBeenCalledWith(
      second.device,
      "bgra8unorm",
    );
    expect(restored).toHaveBeenCalledTimes(1);
  });
});
