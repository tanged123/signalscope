export interface GpuEvidence {
  readonly electronVersion: string;
  readonly chromiumVersion: string;
  readonly adapterVendor: string;
  readonly adapterArchitecture: string;
  readonly adapterDevice: string;
  readonly adapterDescription: string;
  readonly softwareRendering: boolean;
  readonly fallbackReason: string | null;
  readonly limits: Record<string, number>;
}

export type GpuBackend = "hardware" | "software" | "unsupported";

export interface NativeGpuInfo {
  readonly electron?: string;
  readonly chromium?: string;
  readonly softwareRendering?: boolean;
  readonly webGpuStatus?: string;
  readonly fallbackReason?: string | null;
  readonly adapter?: {
    readonly vendor?: string;
    readonly device?: string;
    readonly description?: string;
  };
  readonly gpu?: Readonly<Record<string, unknown>>;
}

const softwarePattern =
  /swiftshader|llvmpipe|lavapipe|warp|software\s+(?:rasterizer|rendering)/i;

export function classifyGpuEvidence(evidence: GpuEvidence): GpuBackend {
  const identity = [
    evidence.adapterVendor,
    evidence.adapterArchitecture,
    evidence.adapterDevice,
    evidence.adapterDescription,
  ].some((value) => value.trim().length > 0);
  const software =
    evidence.softwareRendering ||
    [
      evidence.adapterVendor,
      evidence.adapterArchitecture,
      evidence.adapterDevice,
      evidence.adapterDescription,
    ].some((value) => softwarePattern.test(value));
  if (software) return "software";
  if (!identity || evidence.fallbackReason !== null) return "unsupported";
  return "hardware";
}

export function gpuEvidenceFromAdapter(
  adapter: GPUAdapter,
  limits: GPUSupportedLimits,
  native: NativeGpuInfo | undefined = undefined,
): GpuEvidence {
  const info = (adapter as GPUAdapter & { info?: unknown }).info as
    | {
        vendor?: unknown;
        architecture?: unknown;
        device?: unknown;
        description?: unknown;
      }
    | undefined;
  const device = nativeDevice(native);
  const adapterVendor =
    text(info?.vendor) || native?.adapter?.vendor || text(device?.driverVendor);
  const adapterDevice =
    text(info?.device) || native?.adapter?.device || numeric(device?.deviceId);
  const adapterDescription =
    text(info?.description) ||
    native?.adapter?.description ||
    text(device?.description);
  const adapterArchitecture = text(info?.architecture);
  const fallbackReason =
    native?.fallbackReason ??
    (adapterVendor || adapterDevice || adapterDescription
      ? null
      : "adapter identity unavailable");

  return {
    electronVersion: native?.electron ?? "browser",
    chromiumVersion: native?.chromium ?? "unknown",
    adapterVendor,
    adapterArchitecture,
    adapterDevice,
    adapterDescription,
    softwareRendering: native?.softwareRendering ?? false,
    fallbackReason,
    limits: supportedLimits(limits),
  };
}

export function gpuEvidenceFromNative(native: NativeGpuInfo): GpuEvidence {
  const device = nativeDevice(native);
  const adapterVendor = native.adapter?.vendor ?? text(device?.driverVendor);
  const adapterDevice = native.adapter?.device ?? numeric(device?.deviceId);
  const adapterDescription =
    native.adapter?.description ?? text(device?.description);
  return {
    electronVersion: native.electron ?? "unknown",
    chromiumVersion: native.chromium ?? "unknown",
    adapterVendor,
    adapterArchitecture: "",
    adapterDevice,
    adapterDescription,
    softwareRendering: native.softwareRendering ?? false,
    fallbackReason:
      native.fallbackReason ??
      (native.webGpuStatus === "disabled" ||
      native.webGpuStatus === "unavailable"
        ? `webgpu ${native.webGpuStatus}`
        : adapterVendor || adapterDevice || adapterDescription
          ? null
          : "adapter identity unavailable"),
    limits: {},
  };
}

function supportedLimits(limits: GPUSupportedLimits): Record<string, number> {
  const names = [
    "maxStorageBuffersPerShaderStage",
    "maxComputeWorkgroupSizeX",
    "maxComputeInvocationsPerWorkgroup",
    "maxStorageBufferBindingSize",
    "maxBufferSize",
  ] as const;
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = limits[name];
      return Number.isFinite(value) ? [[name, value]] : [];
    }),
  );
}

function nativeDevice(native: NativeGpuInfo | undefined):
  | {
      driverVendor?: unknown;
      deviceId?: unknown;
      description?: unknown;
    }
  | undefined {
  const rawDevices: unknown = native?.gpu?.devices;
  if (!Array.isArray(rawDevices)) return undefined;
  const devices: unknown[] = rawDevices;
  const active = devices.find(isActiveDevice);
  const first = active ?? devices[0];
  return typeof first === "object" && first !== null
    ? (first as Record<string, unknown>)
    : undefined;
}

function isActiveDevice(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).active === true
  );
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numeric(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `0x${value.toString(16)}`
    : "";
}
