export interface GpuPanelEncoder {
  readonly id: string;
  encode(encoder: GPUCommandEncoder): void;
  afterSubmit?(): void;
  deviceLost(): void;
  deviceRestored(device: GPUDevice, format: GPUTextureFormat): void;
}

export class GpuFrameLoop {
  private readonly panels = new Set<GpuPanelEncoder>();
  private readonly dirty = new Set<GpuPanelEncoder>();
  private readonly failed = new Set<GpuPanelEncoder>();
  private rafHandle: number | null = null;
  private stopped = false;

  constructor(
    private readonly device: GPUDevice,
    private readonly queue: GPUQueue,
    private readonly requestAnimationFrame: (
      callback: FrameRequestCallback,
    ) => number = globalThis.requestAnimationFrame.bind(globalThis),
    private readonly cancelAnimationFrame: (
      handle: number,
    ) => void = globalThis.cancelAnimationFrame.bind(globalThis),
    private readonly reportError: (
      panelId: string,
      error: unknown,
    ) => void = () => undefined,
    private readonly onFrame: (durationMs: number) => void = () => undefined,
  ) {}

  register(panel: GpuPanelEncoder): () => void {
    this.panels.add(panel);
    return () => this.unregister(panel);
  }

  unregister(panel: GpuPanelEncoder): void {
    this.panels.delete(panel);
    this.dirty.delete(panel);
    this.failed.delete(panel);
  }

  request(panel: GpuPanelEncoder): void {
    if (this.stopped || !this.panels.has(panel) || this.failed.has(panel))
      return;
    this.dirty.add(panel);
    if (this.rafHandle !== null) return;
    this.rafHandle = this.requestAnimationFrame(() => this.flush());
  }

  stop(): void {
    this.stopped = true;
    this.dirty.clear();
    if (this.rafHandle !== null) {
      this.cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
  }

  resume(): void {
    this.stopped = false;
  }

  private flush(): void {
    const started = performance.now();
    this.rafHandle = null;
    if (this.stopped || this.dirty.size === 0) {
      this.onFrame(performance.now() - started);
      return;
    }
    const pending = [...this.dirty];
    this.dirty.clear();
    const encoder = this.device.createCommandEncoder({
      label: "signalscope-frame",
    });
    const encoded: GpuPanelEncoder[] = [];
    for (const panel of pending) {
      if (!this.panels.has(panel) || this.failed.has(panel)) continue;
      try {
        panel.encode(encoder);
        encoded.push(panel);
      } catch (error) {
        this.failed.add(panel);
        this.reportError(panel.id, error);
      }
    }
    if (encoded.length > 0) {
      this.queue.submit([encoder.finish()]);
      encoded.forEach((panel) => panel.afterSubmit?.());
    }
    this.onFrame(performance.now() - started);
  }
}
