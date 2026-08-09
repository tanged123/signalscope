export interface GpuDeviceInfo {
  readonly vendorId?: number;
  readonly deviceId?: number;
  readonly driverVersion?: string;
  readonly driverVendor?: string;
  readonly active?: boolean;
  readonly description?: string;
}

export interface ElectronGpuClassification {
  readonly softwareRendering: boolean;
  readonly webGpuStatus: string;
  readonly fallbackReason: string | null;
}

const softwarePattern =
  /swiftshader|llvmpipe|lavapipe|warp|software\s+(?:rasterizer|rendering)/i;

export function classifyElectronGpu(
  featureStatus:
    | Electron.GPUFeatureStatus
    | { readonly webgpu?: string }
    | Readonly<Record<string, string>>,
  activeDevice: GpuDeviceInfo | undefined,
  explicitSoftwareMode: boolean,
): ElectronGpuClassification {
  const webGpuStatus =
    "webgpu" in featureStatus && typeof featureStatus.webgpu === "string"
      ? featureStatus.webgpu
      : "unknown";
  if (webGpuStatus === "disabled" || webGpuStatus === "unavailable") {
    return {
      softwareRendering: false,
      webGpuStatus,
      fallbackReason: `webgpu ${webGpuStatus}`,
    };
  }

  const identity = [
    activeDevice?.driverVendor,
    activeDevice?.description,
    activeDevice?.deviceId,
  ].some((value) => value !== undefined && String(value).trim().length > 0);
  const softwareEvidence = [
    activeDevice?.driverVendor,
    activeDevice?.driverVersion,
    activeDevice?.description,
  ].some((value) => value !== undefined && softwarePattern.test(value));

  return {
    softwareRendering: explicitSoftwareMode || softwareEvidence,
    webGpuStatus,
    fallbackReason: identity ? null : "adapter identity unavailable",
  };
}

export function selectActiveGpuDevice(
  devices: readonly GpuDeviceInfo[],
): GpuDeviceInfo | undefined {
  return devices.find((device) => device.active) ?? devices[0];
}
