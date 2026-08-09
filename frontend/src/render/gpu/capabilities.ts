export const MIN_STORAGE_BINDING_BYTES = 16 * 1024 * 1024;
export const SCAN_WORKGROUP_SIZE = 256;

export type GpuDeviceResult =
  | {
      supported: true;
      adapter: GPUAdapter;
      device: GPUDevice;
      format: GPUTextureFormat;
      limits: GPUSupportedLimits;
    }
  | {
      supported: false;
      capability: string;
      reason: string;
    };

export async function requestGpuDevice(
  gpu: GPU | undefined,
): Promise<GpuDeviceResult> {
  if (gpu === undefined) {
    return {
      supported: false,
      capability: "navigator.gpu",
      reason: "WebGPU is unavailable",
    };
  }
  let adapter: GPUAdapter | null;
  try {
    adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  } catch {
    adapter = null;
  }
  if (adapter === null) {
    try {
      adapter = await gpu.requestAdapter();
    } catch {
      adapter = null;
    }
  }
  if (adapter === null) {
    return {
      supported: false,
      capability: "requestAdapter",
      reason: "WebGPU adapter unavailable",
    };
  }
  const limits = adapter.limits;
  const limitFailure = validateLimits(limits);
  if (limitFailure !== null) {
    return {
      supported: false,
      capability: "adapter.limits",
      reason: limitFailure,
    };
  }
  let device: GPUDevice;
  try {
    device = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBuffersPerShaderStage: limits.maxStorageBuffersPerShaderStage,
        maxComputeWorkgroupSizeX: limits.maxComputeWorkgroupSizeX,
        maxComputeInvocationsPerWorkgroup:
          limits.maxComputeInvocationsPerWorkgroup,
        maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize,
        maxBufferSize: limits.maxBufferSize,
      },
    });
  } catch {
    return {
      supported: false,
      capability: "requestDevice",
      reason: "WebGPU device request failed",
    };
  }
  return {
    supported: true,
    adapter,
    device,
    format: gpu.getPreferredCanvasFormat(),
    limits,
  };
}

export function validateLimits(limits: GPUSupportedLimits): string | null {
  if (limits.maxStorageBuffersPerShaderStage < 5) {
    return "WebGPU requires five storage buffers per shader stage";
  }
  if (limits.maxComputeWorkgroupSizeX < SCAN_WORKGROUP_SIZE) {
    return "WebGPU compute workgroups are too small";
  }
  if (limits.maxComputeInvocationsPerWorkgroup < SCAN_WORKGROUP_SIZE) {
    return "WebGPU compute invocations are too small";
  }
  if (limits.maxStorageBufferBindingSize < MIN_STORAGE_BINDING_BYTES) {
    return "WebGPU storage bindings are too small";
  }
  if (limits.maxBufferSize < MIN_STORAGE_BINDING_BYTES) {
    return "WebGPU buffers are too small";
  }
  return null;
}
