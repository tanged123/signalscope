import { requestGpuDevice, type GpuDeviceResult } from "./capabilities";
import { GpuFrameLoop, type GpuPanelEncoder } from "./frame-loop";
import { GpuMetrics } from "./metrics";
import { compileProductionShaders } from "./shader-sources";

export type GpuRuntimeError =
  | { kind: "lost"; message: string }
  | { kind: "restored" }
  | { kind: "unsupported"; capability: string; reason: string }
  | { kind: "uncaptured"; message: string }
  | { kind: "panel"; panelId: string; error: unknown };

export type GpuRuntimeResult =
  | { supported: true; runtime: GpuRuntime }
  | { supported: false; reason: string; capability: string };

export type GpuRuntimeState =
  | { kind: "ready" }
  | { kind: "recovering"; message: string }
  | { kind: "unsupported"; capability: string; reason: string };

export class GpuRuntime {
  adapter: GPUAdapter;
  device: GPUDevice;
  queue: GPUQueue;
  format: GPUTextureFormat;
  limits: GPUSupportedLimits;
  frameLoop: GpuFrameLoop;
  readonly metrics = new GpuMetrics();

  private readonly panels = new Set<GpuPanelEncoder>();
  private readonly shaders = new Map<string, GPUShaderModule>();
  private readonly renderPipelines = new Map<string, GPURenderPipeline>();
  private readonly computePipelines = new Map<string, GPUComputePipeline>();
  private readonly errorListeners = new Set<(error: GpuRuntimeError) => void>();
  private readonly restoreListeners = new Set<() => void>();
  private readonly gpu: GPU;
  private recovery: Promise<void> | null = null;
  private lossStartedAt: number | null = null;
  private stateValue: GpuRuntimeState = { kind: "ready" };

  private static frameScheduler(): [
    (callback: FrameRequestCallback) => number,
    (handle: number) => void,
  ] {
    const host = globalThis as unknown as {
      requestAnimationFrame?: (callback: FrameRequestCallback) => number;
      cancelAnimationFrame?: (handle: number) => void;
    };
    return [
      host.requestAnimationFrame?.bind(host) ??
        ((callback: FrameRequestCallback) =>
          globalThis.setTimeout(() => callback(performance.now()), 0)),
      host.cancelAnimationFrame?.bind(host) ??
        ((handle: number) => globalThis.clearTimeout(handle)),
    ];
  }

  private constructor(
    gpu: GPU,
    result: Extract<GpuDeviceResult, { supported: true }>,
  ) {
    this.gpu = gpu;
    this.adapter = result.adapter;
    this.device = result.device;
    this.queue = result.device.queue;
    this.format = result.format;
    this.limits = result.limits;
    const [requestFrame, cancelFrame] = GpuRuntime.frameScheduler();
    this.frameLoop = this.makeFrameLoop(requestFrame, cancelFrame);
    this.installDeviceListeners();
  }

  static async create(gpu?: GPU): Promise<GpuRuntimeResult> {
    const result = await requestGpuDevice(gpu);
    if (!result.supported) return result;
    const shaderErrors = await compileProductionShaders(result.device);
    if (shaderErrors.length > 0) {
      result.device.destroy();
      const first = shaderErrors[0] ?? "shader compilation failed";
      const separator = first.indexOf(":");
      const label = separator < 0 ? first : first.slice(0, separator);
      const reason = separator < 0 ? first : first.slice(separator + 1).trim();
      return {
        supported: false,
        capability: `shader.${label}`,
        reason,
      };
    }
    return { supported: true, runtime: new GpuRuntime(gpu as GPU, result) };
  }

  register(panel: GpuPanelEncoder): () => void {
    this.panels.add(panel);
    this.frameLoop.register(panel);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.panels.delete(panel);
      this.frameLoop.unregister(panel);
    };
  }

  state(): GpuRuntimeState {
    return this.stateValue;
  }

  requestFrame(panel: GpuPanelEncoder): void {
    this.frameLoop.request(panel);
  }

  destroyDeviceForTest(): void {
    this.device.destroy();
  }

  shader(label: string, code: string): GPUShaderModule {
    const cached = this.shaders.get(label);
    if (cached !== undefined) return cached;
    const module = this.device.createShaderModule({ label, code });
    this.shaders.set(label, module);
    return module;
  }

  renderPipeline(
    key: string,
    create: () => GPURenderPipeline,
  ): GPURenderPipeline {
    const cached = this.renderPipelines.get(key);
    if (cached !== undefined) return cached;
    const pipeline = create();
    this.renderPipelines.set(key, pipeline);
    return pipeline;
  }

  computePipeline(
    key: string,
    create: () => GPUComputePipeline,
  ): GPUComputePipeline {
    const cached = this.computePipelines.get(key);
    if (cached !== undefined) return cached;
    const pipeline = create();
    this.computePipelines.set(key, pipeline);
    return pipeline;
  }

  onError(listener: (error: GpuRuntimeError) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  onRestored(listener: () => void): () => void {
    this.restoreListeners.add(listener);
    return () => this.restoreListeners.delete(listener);
  }

  private handleLoss(info: GPUDeviceLostInfo): void {
    if (this.recovery !== null) return;
    this.frameLoop.stop();
    this.stateValue = { kind: "recovering", message: info.message };
    this.lossStartedAt = performance.now();
    this.shaders.clear();
    this.renderPipelines.clear();
    this.computePipelines.clear();
    this.panels.forEach((panel) => panel.deviceLost());
    this.publish({ kind: "lost", message: info.message });
    this.recovery = this.restore().finally(() => {
      this.recovery = null;
    });
  }

  private async restore(): Promise<void> {
    const result = await requestGpuDevice(this.gpu);
    if (!result.supported) {
      this.lossStartedAt = null;
      this.stateValue = {
        kind: "unsupported",
        capability: result.capability,
        reason: result.reason,
      };
      this.publish({
        kind: "unsupported",
        capability: result.capability,
        reason: result.reason,
      });
      return;
    }
    const shaderErrors = await compileProductionShaders(result.device);
    if (shaderErrors.length > 0) {
      this.lossStartedAt = null;
      result.device.destroy();
      const first = shaderErrors[0] ?? "shader compilation failed";
      const separator = first.indexOf(":");
      const label = separator < 0 ? first : first.slice(0, separator);
      const reason = separator < 0 ? first : first.slice(separator + 1).trim();
      this.stateValue = {
        kind: "unsupported",
        capability: `shader.${label}`,
        reason,
      };
      this.publish({
        kind: "unsupported",
        capability: `shader.${label}`,
        reason,
      });
      return;
    }
    this.adapter = result.adapter;
    this.device = result.device;
    this.queue = result.device.queue;
    this.format = result.format;
    this.limits = result.limits;
    const [requestFrame, cancelFrame] = GpuRuntime.frameScheduler();
    this.frameLoop = this.makeFrameLoop(requestFrame, cancelFrame);
    this.installDeviceListeners();
    this.panels.forEach((panel) => {
      panel.deviceRestored(this.device, this.format);
      this.frameLoop.register(panel);
    });
    this.stateValue = { kind: "ready" };
    this.restoreListeners.forEach((listener) => listener());
    this.publish({ kind: "restored" });
  }

  private makeFrameLoop(
    requestFrame: (callback: FrameRequestCallback) => number,
    cancelFrame: (handle: number) => void,
  ): GpuFrameLoop {
    return new GpuFrameLoop(
      this.device,
      this.queue,
      requestFrame,
      cancelFrame,
      (panelId, error) => this.publish({ kind: "panel", panelId, error }),
      (durationMs) => this.metrics.recordFrame(durationMs),
      () => {
        if (this.lossStartedAt === null) return;
        this.metrics.recordRecovery(performance.now() - this.lossStartedAt);
        this.lossStartedAt = null;
      },
    );
  }

  private installDeviceListeners(): void {
    this.device.addEventListener("uncapturederror", (event) => {
      const reason = event.error.message;
      this.stateValue = {
        kind: "unsupported",
        capability: "uncaptured-error",
        reason,
      };
      this.publish({ kind: "uncaptured", message: reason });
      this.publish({
        kind: "unsupported",
        capability: "uncaptured-error",
        reason,
      });
    });
    void this.device.lost.then((info) => this.handleLoss(info));
  }

  private publish(error: GpuRuntimeError): void {
    this.errorListeners.forEach((listener) => listener(error));
  }
}
