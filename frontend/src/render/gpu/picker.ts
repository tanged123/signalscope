import pickShader from "./shaders/pick-series.wgsl?raw";
import reduceShader from "./shaders/pick-reduce.wgsl?raw";
import type { GpuMetrics } from "./metrics";

const MAP_READ = 0x0001;
const COPY_DST = 0x0008;
const STORAGE = 0x0080;
const COPY_SRC = 0x0004;

export interface PickRequest {
  readonly sequence: number;
  readonly cursorX: number;
  readonly cursorY: number;
  readonly radius: number;
  readonly explicit: boolean;
}

export interface PickResult {
  readonly sequence: number;
  readonly seriesSlot: number;
  readonly tileMetaIndex: number;
  readonly relativeTime: number;
  readonly value: number;
  readonly distance: number;
}

export interface PickPoint {
  readonly time: number;
  readonly value: number;
  readonly breakBefore: boolean;
}

export interface PickSeries {
  readonly seriesSlot: number;
  readonly visible: boolean;
  readonly points: readonly PickPoint[];
}

export interface CpuPickRequest {
  readonly cursorTime: number;
  readonly cursorX: number;
  readonly cursorY: number;
  readonly radius: number;
}

export interface PickPage {
  readonly pointBuffer: GPUBuffer;
  readonly rangeBuffer: GPUBuffer;
  readonly metadataBuffer: GPUBuffer;
  readonly styleBuffer: GPUBuffer;
  readonly seriesCount: number;
  readonly tileMetaBase: number;
  readonly tileOrigins: readonly number[];
}

export interface PickViewport {
  readonly viewOriginHigh: number;
  readonly viewOriginLow: number;
  readonly timeScale: number;
  readonly plotX: number;
  readonly plotY: number;
  readonly plotWidth: number;
  readonly plotHeight: number;
  readonly canvasHeight: number;
  readonly yMin: number;
  readonly yScale: number;
  readonly canvasWidth: number;
}

export interface GpuPickerScheduler {
  requestFrame(): void;
}

export function pickReductionPlan(candidateCount: number): readonly number[] {
  const dispatches: number[] = [];
  let count = Math.max(0, Math.trunc(candidateCount));
  while (count > 1) {
    count = Math.ceil(count / 256);
    dispatches.push(count);
  }
  return dispatches;
}

interface PickerRuntime {
  readonly device: GPUDevice;
  readonly shader?: (label: string, code: string) => GPUShaderModule;
  readonly computePipeline?: (
    key: string,
    create: () => GPUComputePipeline,
  ) => GPUComputePipeline;
  readonly metrics?: GpuMetrics;
}

interface Work {
  request: PickRequest;
  resolve: (result: PickResult | null) => void;
  startedAt: number;
}

interface Slot {
  sequence: number | null;
  work: Work | null;
  submitted: boolean;
  buffer: GPUBuffer | null;
}

export class GpuPicker {
  private readonly slots: Slot[] = [
    { sequence: null, work: null, submitted: false, buffer: null },
    { sequence: null, work: null, submitted: false, buffer: null },
    { sequence: null, work: null, submitted: false, buffer: null },
  ];
  private readonly explicit: Work[] = [];
  private pendingHover: Work | null = null;
  private latestResult: PickResult | null = null;
  private lastHoverAt = Number.NEGATIVE_INFINITY;
  private device: GPUDevice | undefined;
  private runtime: PickerRuntime | undefined;
  private scene: readonly PickPage[] = [];
  private viewport: PickViewport | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private resultBuffer: GPUBuffer | null = null;
  private candidateBuffer: GPUBuffer | null = null;
  private reduceScratchBuffer: GPUBuffer | null = null;
  private candidateCapacity = 0;
  private reduceCapacity = 0;
  private readonly pageUniforms: GPUBuffer[] = [];
  private readonly reduceParams: GPUBuffer[] = [];
  private tileOrigins: readonly number[] = [];
  private scheduler: GpuPickerScheduler | null = null;
  private pickPipeline: GPUComputePipeline | null = null;
  private reducePipeline: GPUComputePipeline | null = null;

  constructor(
    deviceOrRuntime?: GPUDevice | PickerRuntime,
    private readonly now: () => number = () => performance.now(),
  ) {
    if (deviceOrRuntime !== undefined && "device" in deviceOrRuntime) {
      this.runtime = deviceOrRuntime;
      this.device = deviceOrRuntime.device;
    } else this.device = deviceOrRuntime;
  }

  setScene(scene: readonly PickPage[]): void {
    this.scene = scene;
    const origins: number[] = [];
    for (const page of scene) {
      page.tileOrigins.forEach((origin, index) => {
        origins[page.tileMetaBase + index] = origin;
      });
    }
    this.tileOrigins = origins;
  }

  setScheduler(scheduler: GpuPickerScheduler): void {
    this.scheduler = scheduler;
  }

  resolveTime(result: PickResult): number | null {
    const origin = this.tileOrigins[result.tileMetaIndex];
    return origin === undefined ? null : origin + result.relativeTime;
  }

  setViewport(viewport: PickViewport): void {
    this.viewport = viewport;
  }

  resetDevice(deviceOrRuntime: GPUDevice | PickerRuntime): void {
    this.uniformBuffer = null;
    this.resultBuffer = null;
    this.candidateBuffer = null;
    this.reduceScratchBuffer = null;
    this.candidateCapacity = 0;
    this.reduceCapacity = 0;
    this.pageUniforms.length = 0;
    this.reduceParams.length = 0;
    this.pickPipeline = null;
    this.reducePipeline = null;
    if ("device" in deviceOrRuntime) {
      this.runtime = deviceOrRuntime;
      this.device = deviceOrRuntime.device;
    } else {
      this.runtime = undefined;
      this.device = deviceOrRuntime;
    }
  }

  request(request: PickRequest): Promise<PickResult | null> {
    return new Promise((resolve) => {
      const work = { request, resolve, startedAt: this.now() };
      if (request.explicit) {
        this.explicit.push(work);
        return;
      }
      const time = this.now();
      if (time - this.lastHoverAt < 1000 / 30 && this.pendingHover !== null) {
        this.pendingHover.resolve(null);
        this.pendingHover = null;
      }
      this.lastHoverAt = time;
      if (this.pendingHover !== null) this.pendingHover.resolve(null);
      this.pendingHover = work;
    });
  }

  latest(): PickResult | null {
    return this.latestResult;
  }

  encode(encoder: GPUCommandEncoder): void {
    const work = this.explicit[0] ?? this.pendingHover;
    if (work === null) return;
    const slot = this.slots.find((candidate) => candidate.work === null);
    if (slot === undefined) {
      if (!work.request.explicit && this.pendingHover === work) {
        this.pendingHover = null;
        work.resolve(null);
      }
      return;
    }
    if (work.request.explicit) this.explicit.shift();
    else this.pendingHover = null;
    slot.sequence = work.request.sequence;
    slot.work = work;
    slot.submitted = true;
    if (this.device !== undefined) {
      slot.buffer ??= this.device.createBuffer({
        label: "signalscope-pick-readback",
        size: 32,
        usage: MAP_READ | COPY_DST,
      });
      this.encodeGpu(encoder, work.request, slot.buffer);
    }
  }

  afterSubmit(): void {
    for (const slot of this.slots) {
      if (!slot.submitted || slot.buffer === null) continue;
      slot.submitted = false;
      void this.readSlot(slot);
    }
  }

  complete(sequence: number, result: PickResult | null): void {
    const slot = this.slots.find(
      (candidate) => candidate.sequence === sequence,
    );
    if (slot === undefined || slot.work === null) return;
    slot.sequence = null;
    const work = slot.work;
    slot.work = null;
    if (
      result !== null &&
      (this.latestResult === null || sequence > this.latestResult.sequence)
    )
      this.latestResult = result;
    this.runtime?.metrics?.recordPickLatency(this.now() - work.startedAt);
    work.resolve(result);
    if (this.explicit.length > 0 || this.pendingHover !== null) {
      this.scheduler?.requestFrame();
    }
  }

  private async readSlot(slot: Slot): Promise<void> {
    if (slot.buffer === null || slot.sequence === null || slot.work === null)
      return;
    const sequence = slot.sequence;
    try {
      await slot.buffer.mapAsync(MAP_READ);
      const view = new DataView(slot.buffer.getMappedRange());
      const result: PickResult | null =
        view.getUint32(24, true) === 0
          ? null
          : {
              sequence: view.getUint32(0, true),
              seriesSlot: view.getUint32(4, true),
              tileMetaIndex: view.getUint32(8, true),
              distance: view.getFloat32(12, true),
              relativeTime: view.getFloat32(16, true),
              value: view.getFloat32(20, true),
            };
      slot.buffer.unmap();
      this.complete(sequence, result);
    } catch {
      this.complete(sequence, null);
    }
  }

  private encodeGpu(
    encoder: GPUCommandEncoder,
    request: PickRequest,
    readback: GPUBuffer | null,
  ): void {
    if (
      this.device === undefined ||
      readback === null ||
      this.scene.length === 0
    )
      return;
    if (this.viewport === null) return;
    const candidateCount = this.scene.reduce(
      (total, page) => total + page.seriesCount,
      0,
    );
    if (candidateCount === 0) return;
    this.uniformBuffer ??= this.device.createBuffer({
      label: "signalscope-pick-uniforms",
      size: 80,
      usage: 0x0040 | COPY_DST,
    });
    this.resultBuffer ??= this.device.createBuffer({
      label: "signalscope-pick-result",
      size: 32,
      usage: STORAGE | COPY_SRC | COPY_DST,
    });
    const resultBuffer = this.resultBuffer;
    if (resultBuffer === null) return;
    this.ensureCandidateBuffer(candidateCount);
    const candidateBuffer = this.candidateBuffer;
    if (candidateBuffer === null) return;
    this.ensureReduceScratch(candidateCount);
    const reduceScratchBuffer = this.reduceScratchBuffer;
    if (reduceScratchBuffer === null) return;
    const values = new ArrayBuffer(80);
    const view = new DataView(values);
    view.setFloat32(0, request.cursorX, true);
    view.setFloat32(4, request.cursorY, true);
    view.setFloat32(8, request.radius, true);
    view.setUint32(12, request.sequence, true);
    view.setFloat32(16, this.viewport.viewOriginHigh, true);
    view.setFloat32(20, this.viewport.viewOriginLow, true);
    view.setFloat32(24, this.viewport.timeScale, true);
    view.setFloat32(28, this.viewport.plotX, true);
    view.setFloat32(32, this.viewport.plotY, true);
    view.setFloat32(36, this.viewport.plotWidth, true);
    view.setFloat32(40, this.viewport.plotHeight, true);
    view.setFloat32(44, this.viewport.canvasHeight, true);
    view.setFloat32(48, this.viewport.yMin, true);
    view.setFloat32(52, this.viewport.yScale, true);
    view.setFloat32(56, this.viewport.canvasWidth, true);
    view.setUint32(60, candidateCount, true);
    this.device.queue.writeBuffer(
      this.uniformBuffer,
      0,
      new Uint8Array(values) as unknown as GPUAllowSharedBufferSource,
    );
    this.pickPipeline ??=
      this.runtime?.computePipeline?.("pick-series", () =>
        this.makePipeline(),
      ) ?? this.makePipeline();
    this.reducePipeline ??=
      this.runtime?.computePipeline?.("pick-reduce", () =>
        this.makeReducePipeline(),
      ) ?? this.makeReducePipeline();
    const pass = encoder.beginComputePass({ label: "signalscope-pick" });
    pass.setPipeline(this.pickPipeline);
    let candidateOffset = 0;
    for (const [index, page] of this.scene.entries()) {
      if (page.seriesCount === 0) continue;
      const pageUniform =
        this.pageUniforms[index] ?? this.createPageUniform(index);
      const pageData = new Uint32Array([
        candidateOffset,
        page.seriesCount,
        page.tileMetaBase,
        0,
      ]);
      this.device.queue.writeBuffer(
        pageUniform,
        0,
        pageData as unknown as GPUAllowSharedBufferSource,
      );
      pass.setBindGroup(
        0,
        this.device.createBindGroup({
          layout: this.pickPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.uniformBuffer } },
            { binding: 1, resource: { buffer: page.pointBuffer } },
            { binding: 2, resource: { buffer: page.rangeBuffer } },
            { binding: 3, resource: { buffer: page.metadataBuffer } },
            { binding: 4, resource: { buffer: page.styleBuffer } },
            { binding: 5, resource: { buffer: candidateBuffer } },
            { binding: 6, resource: { buffer: pageUniform } },
          ],
        }),
      );
      pass.dispatchWorkgroups(Math.ceil(page.seriesCount / 256));
      candidateOffset += page.seriesCount;
    }
    pass.end();
    let currentCount = candidateCount;
    let input = candidateBuffer;
    let output = reduceScratchBuffer;
    let reduceLevel = 0;
    while (currentCount > 1) {
      const outputCount = Math.ceil(currentCount / 256);
      if (outputCount === 1) output = resultBuffer;
      const params =
        this.reduceParams[reduceLevel] ?? this.createReduceParams(reduceLevel);
      this.device.queue.writeBuffer(
        params,
        0,
        new Uint32Array([
          currentCount,
          0,
          0,
          0,
        ]) as unknown as GPUAllowSharedBufferSource,
      );
      const reducePass = encoder.beginComputePass({
        label: "signalscope-pick-reduce",
      });
      reducePass.setPipeline(this.reducePipeline);
      reducePass.setBindGroup(
        0,
        this.device.createBindGroup({
          layout: this.reducePipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.uniformBuffer } },
            { binding: 1, resource: { buffer: input } },
            { binding: 2, resource: { buffer: output } },
            { binding: 3, resource: { buffer: params } },
          ],
        }),
      );
      reducePass.dispatchWorkgroups(outputCount);
      reducePass.end();
      currentCount = outputCount;
      reduceLevel += 1;
      if (currentCount > 1) {
        const next = input;
        input = output;
        output = next;
      }
    }
    if (candidateCount === 1) {
      encoder.copyBufferToBuffer(candidateBuffer, 0, resultBuffer, 0, 32);
    }
    encoder.copyBufferToBuffer(resultBuffer, 0, readback, 0, 32);
  }

  private makePipeline(): GPUComputePipeline {
    const module =
      this.runtime?.shader?.("pick-series", pickShader) ??
      this.device?.createShaderModule({
        label: "pick-series",
        code: pickShader,
      });
    if (module === undefined) throw new Error("GPU picker device unavailable");
    const device = this.device;
    if (device === undefined) throw new Error("GPU picker device unavailable");
    return device.createComputePipeline({
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });
  }

  private makeReducePipeline(): GPUComputePipeline {
    const module =
      this.runtime?.shader?.("pick-reduce", reduceShader) ??
      this.device?.createShaderModule({
        label: "pick-reduce",
        code: reduceShader,
      });
    if (module === undefined) throw new Error("GPU picker device unavailable");
    const device = this.device;
    if (device === undefined) throw new Error("GPU picker device unavailable");
    return device.createComputePipeline({
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });
  }

  private ensureCandidateBuffer(count: number): void {
    if (this.candidateBuffer !== null && this.candidateCapacity >= count)
      return;
    this.candidateBuffer?.destroy();
    this.candidateCapacity = nextPowerOfTwo(count);
    this.candidateBuffer =
      this.device?.createBuffer({
        label: "signalscope-pick-candidates",
        size: this.candidateCapacity * 32,
        usage: STORAGE | COPY_SRC,
      }) ?? null;
  }

  private ensureReduceScratch(count: number): void {
    const required = nextPowerOfTwo(Math.max(1, Math.ceil(count / 256)));
    if (this.reduceScratchBuffer !== null && this.reduceCapacity >= required)
      return;
    this.reduceScratchBuffer?.destroy();
    this.reduceScratchBuffer =
      this.device?.createBuffer({
        label: "signalscope-pick-reduce-scratch",
        size: Math.max(32, required * 32),
        usage: STORAGE,
      }) ?? null;
    this.reduceCapacity = required;
  }

  private createPageUniform(index: number): GPUBuffer {
    const buffer = this.device?.createBuffer({
      label: `signalscope-pick-page-${String(index)}`,
      size: 16,
      usage: 0x0040 | COPY_DST,
    });
    if (buffer === undefined) throw new Error("GPU picker device unavailable");
    this.pageUniforms[index] = buffer;
    return buffer;
  }

  private createReduceParams(index: number): GPUBuffer {
    const buffer = this.device?.createBuffer({
      label: `signalscope-pick-reduce-params-${String(index)}`,
      size: 16,
      usage: 0x0040 | COPY_DST,
    });
    if (buffer === undefined) throw new Error("GPU picker device unavailable");
    this.reduceParams[index] = buffer;
    return buffer;
  }
}

function nextPowerOfTwo(value: number): number {
  let result = 1;
  while (result < value) result *= 2;
  return result;
}

export function nearestCpuPick(
  request: CpuPickRequest,
  series: readonly PickSeries[],
  project: (time: number, value: number) => { x: number; y: number },
): PickResult | null {
  let best: PickResult | null = null;
  for (const line of series) {
    if (!line.visible) continue;
    const points = line.points;
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index];
      if (
        point === undefined ||
        !Number.isFinite(point.time) ||
        !Number.isFinite(point.value)
      )
        continue;
      best = nearer(
        best,
        line.seriesSlot,
        point.time,
        point.value,
        request,
        project,
      );
      const next = points[index + 1];
      if (
        next === undefined ||
        next.breakBefore ||
        !Number.isFinite(next.time) ||
        !Number.isFinite(next.value) ||
        next.time === point.time
      )
        continue;
      const ratio = Math.max(
        0,
        Math.min(
          1,
          (request.cursorTime - point.time) / (next.time - point.time),
        ),
      );
      best = nearer(
        best,
        line.seriesSlot,
        point.time + (next.time - point.time) * ratio,
        point.value + (next.value - point.value) * ratio,
        request,
        project,
      );
    }
  }
  return best;
}

function nearer(
  best: PickResult | null,
  seriesSlot: number,
  time: number,
  value: number,
  request: CpuPickRequest,
  project: (time: number, value: number) => { x: number; y: number },
): PickResult | null {
  const point = project(time, value);
  const distance = Math.hypot(
    point.x - request.cursorX,
    point.y - request.cursorY,
  );
  if (distance > request.radius) return best;
  if (
    best !== null &&
    (distance > best.distance ||
      (distance === best.distance && seriesSlot >= best.seriesSlot))
  )
    return best;
  return {
    sequence: 0,
    seriesSlot,
    tileMetaIndex: 0,
    relativeTime: time,
    value,
    distance,
  };
}
