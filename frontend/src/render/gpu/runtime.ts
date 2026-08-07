import { requestGpuDevice, type GpuDeviceResult } from "./capabilities";
import { GpuFrameLoop, type GpuPanelEncoder } from "./frame-loop";

export type GpuRuntimeError =
  | { kind: "lost"; message: string }
  | { kind: "restored" }
  | { kind: "uncaptured"; message: string }
  | { kind: "panel"; panelId: string; error: unknown };

export type GpuRuntimeResult =
  | { supported: true; runtime: GpuRuntime }
  | { supported: false; reason: string; capability: string };

export class GpuRuntime {
  adapter: GPUAdapter;
  device: GPUDevice;
  queue: GPUQueue;
  format: GPUTextureFormat;
  limits: GPUSupportedLimits;
  frameLoop: GpuFrameLoop;

  private readonly panels = new Set<GpuPanelEncoder>();
  private readonly shaders = new Map<string, GPUShaderModule>();
  private readonly renderPipelines = new Map<string, GPURenderPipeline>();
  private readonly computePipelines = new Map<string, GPUComputePipeline>();
  private readonly errorListeners = new Set<(error: GpuRuntimeError) => void>();
  private readonly restoreListeners = new Set<() => void>();
  private readonly gpu: GPU;
  private recovery: Promise<void> | null = null;

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
    return { supported: true, runtime: new GpuRuntime(gpu as GPU, result) };
  }

  register(panel: GpuPanelEncoder): () => void {
    this.panels.add(panel);
    return this.frameLoop.register(panel);
  }

  requestFrame(panel: GpuPanelEncoder): void {
    this.frameLoop.request(panel);
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
      this.publish({ kind: "lost", message: result.reason });
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
    );
  }

  private installDeviceListeners(): void {
    this.device.addEventListener("uncapturederror", (event) => {
      this.publish({ kind: "uncaptured", message: event.error.message });
    });
    void this.device.lost.then((info) => this.handleLoss(info));
  }

  private publish(error: GpuRuntimeError): void {
    this.errorListeners.forEach((listener) => listener(error));
  }
}
