import type { GpuRuntime } from "./runtime";
import flagsShader from "./shaders/segment-flags.wgsl?raw";
import scanBlocksShader from "./shaders/scan-blocks.wgsl?raw";
import scanAddShader from "./shaders/scan-add.wgsl?raw";
import scatterShader from "./shaders/segment-scatter.wgsl?raw";
import indirectShader from "./shaders/indirect-args.wgsl?raw";

const GPU_BUFFER_COPY_DST = 0x0008;
const GPU_BUFFER_COPY_SRC = 0x0004;
const GPU_BUFFER_STORAGE = 0x0080;
const GPU_BUFFER_INDIRECT = 0x0100;
const GPU_BUFFER_UNIFORM = 0x0040;
const GPU_BUFFER_MAP_READ = 0x0001;
const WORKGROUP_SIZE = 256;

export interface DescriptorBuildBuffers {
  readonly descriptors: GPUBuffer;
  readonly descriptorCount: GPUBuffer;
  readonly quadArgs: GPUBuffer;
  readonly hairlineArgs: GPUBuffer;
}

export interface DescriptorReadback {
  readonly descriptors: Uint32Array;
  readonly descriptorCount: number;
  readonly quadArgs: Uint32Array;
  readonly hairlineArgs: Uint32Array;
}

export interface DescriptorFixtureResult {
  readonly descriptors: readonly number[];
  readonly descriptorCount: number;
  readonly quadArgs: readonly number[];
  readonly hairlineArgs: readonly number[];
}

export function descriptorFixtureResult(
  readback: DescriptorReadback,
): DescriptorFixtureResult {
  return {
    descriptors: [...readback.descriptors],
    descriptorCount: readback.descriptorCount,
    quadArgs: [...readback.quadArgs],
    hairlineArgs: [...readback.hairlineArgs],
  };
}

interface BlockBuffers {
  readonly sums: GPUBuffer;
  readonly prefixes: GPUBuffer;
  readonly params: GPUBuffer;
}

export class GpuDescriptorPipeline {
  private readonly runtime: GpuRuntime;
  private readonly points: GPUBuffer;
  private flagParams: GPUBuffer | null = null;
  private scatterParams: GPUBuffer | null = null;
  private addParams: GPUBuffer | null = null;
  private flags: GPUBuffer | null = null;
  private prefixes: GPUBuffer | null = null;
  private descriptors: GPUBuffer | null = null;
  private descriptorCount: GPUBuffer | null = null;
  private quadArgs: GPUBuffer | null = null;
  private hairlineArgs: GPUBuffer | null = null;
  private hairlineComputeArgs: GPUBuffer | null = null;
  private descriptorCountReadback: GPUBuffer | null = null;
  private countReadbackPending = false;
  private blocks: BlockBuffers[] = [];
  private candidateCapacity = 0;
  private directoryCount = 0;

  constructor(runtime: GpuRuntime, points: GPUBuffer) {
    this.runtime = runtime;
    this.points = points;
  }

  ensureCapacity(candidateCount: number, tileCount: number): void {
    if (
      candidateCount <= this.candidateCapacity &&
      tileCount <= this.directoryCount &&
      this.flagParams !== null
    ) {
      this.directoryCount = tileCount;
      return;
    }
    this.destroyBuffers();
    this.candidateCapacity = nextCapacity(Math.max(1, candidateCount));
    this.directoryCount = tileCount;
    this.flagParams = this.createBuffer(
      "flag-params",
      16,
      GPU_BUFFER_UNIFORM | GPU_BUFFER_COPY_DST,
    );
    this.scatterParams = this.createBuffer(
      "scatter-params",
      16,
      GPU_BUFFER_UNIFORM | GPU_BUFFER_COPY_DST,
    );
    this.addParams = this.createBuffer(
      "add-params",
      16,
      GPU_BUFFER_UNIFORM | GPU_BUFFER_COPY_DST,
    );
    this.flags = this.createBuffer(
      "segment-flags",
      this.candidateCapacity * 4,
      GPU_BUFFER_STORAGE | GPU_BUFFER_COPY_DST,
    );
    this.prefixes = this.createBuffer(
      "segment-prefixes",
      this.candidateCapacity * 4,
      GPU_BUFFER_STORAGE | GPU_BUFFER_COPY_DST,
    );
    this.descriptors = this.createBuffer(
      "segment-descriptors",
      this.candidateCapacity * 16,
      GPU_BUFFER_STORAGE | GPU_BUFFER_COPY_SRC,
    );
    this.descriptorCount = this.createBuffer(
      "descriptor-count",
      4,
      GPU_BUFFER_STORAGE | GPU_BUFFER_COPY_DST | GPU_BUFFER_COPY_SRC,
    );
    this.quadArgs = this.createBuffer(
      "quad-indirect-args",
      16,
      GPU_BUFFER_STORAGE |
        GPU_BUFFER_COPY_DST |
        GPU_BUFFER_COPY_SRC |
        GPU_BUFFER_INDIRECT,
    );
    this.hairlineArgs = this.createBuffer(
      "hairline-indirect-args",
      16,
      GPU_BUFFER_COPY_DST | GPU_BUFFER_COPY_SRC | GPU_BUFFER_INDIRECT,
    );
    this.hairlineComputeArgs = this.createBuffer(
      "hairline-compute-args",
      16,
      GPU_BUFFER_STORAGE | GPU_BUFFER_COPY_DST | GPU_BUFFER_COPY_SRC,
    );
    this.descriptorCountReadback = this.runtime.device.createBuffer({
      label: "signalscope-descriptor-count-readback",
      size: 4,
      usage: GPU_BUFFER_MAP_READ | GPU_BUFFER_COPY_DST,
    });

    let valueCount = this.candidateCapacity;
    do {
      const blockCount = Math.ceil(valueCount / WORKGROUP_SIZE);
      this.blocks.push({
        sums: this.createBuffer(
          `scan-sums-${String(this.blocks.length)}`,
          Math.max(4, blockCount * 4),
          GPU_BUFFER_STORAGE,
        ),
        prefixes: this.createBuffer(
          `scan-prefixes-${String(this.blocks.length)}`,
          Math.max(4, valueCount * 4),
          GPU_BUFFER_STORAGE,
        ),
        params: this.createBuffer(
          `scan-params-${String(this.blocks.length)}`,
          16,
          GPU_BUFFER_UNIFORM | GPU_BUFFER_COPY_DST,
        ),
      });
      valueCount = blockCount;
    } while (valueCount > 1);
  }

  encode(
    encoder: GPUCommandEncoder,
    directories: GPUBuffer,
    candidateCount: number,
  ): DescriptorBuildBuffers {
    if (
      this.flagParams === null ||
      this.scatterParams === null ||
      this.addParams === null ||
      this.flags === null ||
      this.prefixes === null ||
      this.descriptors === null ||
      this.descriptorCount === null ||
      this.quadArgs === null ||
      this.hairlineArgs === null ||
      this.hairlineComputeArgs === null
    ) {
      throw new Error("descriptor pipeline capacity is not initialized");
    }
    this.runtime.queue.writeBuffer(
      this.flagParams,
      0,
      new Uint32Array([
        candidateCount,
        this.directoryCount,
        0,
        0,
      ]) as unknown as GPUAllowSharedBufferSource,
    );
    if (candidateCount === 0 || this.directoryCount === 0) {
      this.runtime.queue.writeBuffer(
        this.descriptorCount,
        0,
        new Uint32Array([0]) as unknown as GPUAllowSharedBufferSource,
      );
      this.runtime.queue.writeBuffer(
        this.quadArgs,
        0,
        new Uint32Array([6, 0, 0, 0]) as unknown as GPUAllowSharedBufferSource,
      );
      this.runtime.queue.writeBuffer(
        this.hairlineArgs,
        0,
        new Uint32Array([2, 0, 0, 0]) as unknown as GPUAllowSharedBufferSource,
      );
      return this.buffers();
    }

    const flagsPipeline = this.computePipeline("segment-flags", flagsShader);
    const scanPipeline = this.computePipeline("scan-blocks", scanBlocksShader);
    const addPipeline = this.computePipeline("scan-add", scanAddShader);
    const scatterPipeline = this.computePipeline(
      "segment-scatter",
      scatterShader,
    );
    const indirectPipeline = this.computePipeline(
      "indirect-args",
      indirectShader,
    );

    {
      const pass = encoder.beginComputePass({ label: "segment-flags" });
      pass.setPipeline(flagsPipeline);
      pass.setBindGroup(
        0,
        this.bindGroup(flagsPipeline, [
          { binding: 0, resource: { buffer: directories } },
          { binding: 1, resource: { buffer: this.points } },
          { binding: 2, resource: { buffer: this.flags } },
          { binding: 3, resource: { buffer: this.flagParams } },
        ]),
      );
      pass.dispatchWorkgroups(Math.ceil(candidateCount / WORKGROUP_SIZE));
      pass.end();
    }

    const firstBlock = this.blocks[0];
    if (firstBlock === undefined)
      throw new Error("descriptor scan has no blocks");
    let level = 0;
    let valueCount = candidateCount;
    this.encodeScan(
      encoder,
      scanPipeline,
      this.flags,
      this.prefixes,
      firstBlock.sums,
      candidateCount,
      firstBlock.params,
    );
    let blockCount = Math.ceil(valueCount / WORKGROUP_SIZE);
    while (blockCount > 1) {
      const previous = this.blocks[level];
      const current = this.blocks[level + 1];
      if (previous === undefined || current === undefined) {
        throw new Error("descriptor scan capacity is not initialized");
      }
      level += 1;
      this.encodeScan(
        encoder,
        scanPipeline,
        previous.sums,
        current.prefixes,
        current.sums,
        blockCount,
        current.params,
      );
      valueCount = blockCount;
      blockCount = Math.ceil(valueCount / WORKGROUP_SIZE);
    }
    const totalBlock = this.blocks[level];
    if (totalBlock === undefined)
      throw new Error("descriptor scan has no total");
    if (Math.ceil(candidateCount / WORKGROUP_SIZE) > 1) {
      this.runtime.queue.writeBuffer(
        this.addParams,
        0,
        new Uint32Array([
          candidateCount,
          this.directoryCount,
          0,
          0,
        ]) as unknown as GPUAllowSharedBufferSource,
      );
      const pass = encoder.beginComputePass({ label: "scan-add" });
      pass.setPipeline(addPipeline);
      pass.setBindGroup(
        0,
        this.bindGroup(addPipeline, [
          { binding: 0, resource: { buffer: this.prefixes } },
          {
            binding: 1,
            resource: {
              buffer: this.blocks[1]?.prefixes ?? firstBlock.prefixes,
            },
          },
          { binding: 2, resource: { buffer: this.addParams } },
        ]),
      );
      pass.dispatchWorkgroups(Math.ceil(candidateCount / WORKGROUP_SIZE));
      pass.end();
    }

    this.runtime.queue.writeBuffer(
      this.scatterParams,
      0,
      new Uint32Array([
        candidateCount,
        this.directoryCount,
        0,
        0,
      ]) as unknown as GPUAllowSharedBufferSource,
    );
    {
      const pass = encoder.beginComputePass({ label: "segment-scatter" });
      pass.setPipeline(scatterPipeline);
      pass.setBindGroup(
        0,
        this.bindGroup(scatterPipeline, [
          { binding: 0, resource: { buffer: directories } },
          { binding: 1, resource: { buffer: this.flags } },
          { binding: 2, resource: { buffer: this.prefixes } },
          { binding: 3, resource: { buffer: this.descriptors } },
          { binding: 4, resource: { buffer: this.scatterParams } },
        ]),
      );
      pass.dispatchWorkgroups(Math.ceil(candidateCount / WORKGROUP_SIZE));
      pass.end();
    }

    {
      const pass = encoder.beginComputePass({ label: "indirect-args" });
      pass.setPipeline(indirectPipeline);
      pass.setBindGroup(
        0,
        this.bindGroup(indirectPipeline, [
          { binding: 0, resource: { buffer: totalBlock.sums } },
          { binding: 1, resource: { buffer: this.descriptorCount } },
          { binding: 2, resource: { buffer: this.quadArgs } },
          { binding: 3, resource: { buffer: this.hairlineComputeArgs } },
        ]),
      );
      pass.dispatchWorkgroups(1);
      pass.end();
    }
    encoder.copyBufferToBuffer(
      this.hairlineComputeArgs,
      0,
      this.hairlineArgs,
      0,
      16,
    );
    if (this.descriptorCountReadback !== null) {
      encoder.copyBufferToBuffer(
        this.descriptorCount,
        0,
        this.descriptorCountReadback,
        0,
        4,
      );
      this.countReadbackPending = true;
    }
    return this.buffers();
  }

  afterSubmit(onCount: (count: number) => void): void {
    if (!this.countReadbackPending || this.descriptorCountReadback === null)
      return;
    this.countReadbackPending = false;
    void this.readCount(onCount);
  }

  destroy(): void {
    this.destroyBuffers();
    this.candidateCapacity = 0;
    this.directoryCount = 0;
  }

  private encodeScan(
    encoder: GPUCommandEncoder,
    pipeline: GPUComputePipeline,
    input: GPUBuffer,
    output: GPUBuffer,
    sums: GPUBuffer,
    valueCount: number,
    params: GPUBuffer,
  ): void {
    this.runtime.queue.writeBuffer(
      params,
      0,
      new Uint32Array([
        valueCount,
        this.directoryCount,
        0,
        0,
      ]) as unknown as GPUAllowSharedBufferSource,
    );
    const pass = encoder.beginComputePass({ label: "scan-blocks" });
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      this.bindGroup(pipeline, [
        { binding: 0, resource: { buffer: input } },
        { binding: 1, resource: { buffer: output } },
        { binding: 2, resource: { buffer: sums } },
        { binding: 3, resource: { buffer: params } },
      ]),
    );
    pass.dispatchWorkgroups(Math.ceil(valueCount / WORKGROUP_SIZE));
    pass.end();
  }

  private buffers(): DescriptorBuildBuffers {
    if (
      this.descriptors === null ||
      this.descriptorCount === null ||
      this.quadArgs === null ||
      this.hairlineArgs === null
    ) {
      throw new Error("descriptor pipeline buffers are not initialized");
    }
    return {
      descriptors: this.descriptors,
      descriptorCount: this.descriptorCount,
      quadArgs: this.quadArgs,
      hairlineArgs: this.hairlineArgs,
    };
  }

  private createBuffer(label: string, size: number, usage: number): GPUBuffer {
    return this.runtime.device.createBuffer({
      label: `signalscope-${label}`,
      size: Math.max(4, size),
      usage,
    });
  }

  private computePipeline(label: string, code: string): GPUComputePipeline {
    return this.runtime.computePipeline(label, () =>
      this.runtime.device.createComputePipeline({
        layout: "auto",
        compute: {
          module: this.runtime.shader(label, code),
          entryPoint: "main",
        },
      }),
    );
  }

  private bindGroup(
    pipeline: GPUComputePipeline,
    entries: GPUBindGroupEntry[],
  ): GPUBindGroup {
    return this.runtime.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries,
    });
  }

  private destroyBuffers(): void {
    this.flagParams?.destroy();
    this.scatterParams?.destroy();
    this.addParams?.destroy();
    this.flags?.destroy();
    this.prefixes?.destroy();
    this.descriptors?.destroy();
    this.descriptorCount?.destroy();
    this.quadArgs?.destroy();
    this.hairlineArgs?.destroy();
    this.hairlineComputeArgs?.destroy();
    this.descriptorCountReadback?.destroy();
    this.blocks.forEach((block) => {
      block.sums.destroy();
      block.prefixes.destroy();
    });
    this.flagParams = null;
    this.scatterParams = null;
    this.addParams = null;
    this.flags = null;
    this.prefixes = null;
    this.descriptors = null;
    this.descriptorCount = null;
    this.quadArgs = null;
    this.hairlineArgs = null;
    this.hairlineComputeArgs = null;
    this.descriptorCountReadback = null;
    this.countReadbackPending = false;
    this.blocks = [];
  }

  private async readCount(onCount: (count: number) => void): Promise<void> {
    const readback = this.descriptorCountReadback;
    if (readback === null) return;
    try {
      await readback.mapAsync(GPU_BUFFER_MAP_READ);
      const count = new Uint32Array(readback.getMappedRange())[0] ?? 0;
      readback.unmap();
      onCount(count);
    } catch {
      // Device loss resolves the pending frame through runtime recovery.
    }
  }
}

function nextCapacity(required: number): number {
  let capacity = 1;
  while (capacity < required) capacity *= 2;
  return capacity;
}

export async function runDescriptorFixture(
  runtime: GpuRuntime,
): Promise<DescriptorReadback> {
  let stage = "allocate";
  const pointCount = 7;
  let points: GPUBuffer | null = null;
  let directories: GPUBuffer | null = null;
  let pipeline: GpuDescriptorPipeline | null = null;
  let staging: GPUBuffer | null = null;
  try {
    stage = "allocate points";
    points = runtime.device.createBuffer({
      label: "signalscope-descriptor-fixture-points",
      size: pointCount * 16,
      usage: GPU_BUFFER_STORAGE | GPU_BUFFER_COPY_DST,
    });
    directories = runtime.device.createBuffer({
      label: "signalscope-descriptor-fixture-directories",
      size: 32,
      usage: GPU_BUFFER_STORAGE | GPU_BUFFER_COPY_DST,
    });
    const pointBytes = new ArrayBuffer(pointCount * 16);
    const pointView = new DataView(pointBytes);
    [0, 0, 1, 1, 0, 1, 0].forEach((flags, index) => {
      pointView.setFloat32(index * 16, index < 4 ? 1 : 2, true);
      pointView.setFloat32(index * 16 + 4, index < 4 ? 5 : 7, true);
      pointView.setUint32(index * 16 + 8, flags, true);
    });
    runtime.queue.writeBuffer(
      points,
      0,
      new Uint8Array(pointBytes) as unknown as GPUAllowSharedBufferSource,
    );
    runtime.queue.writeBuffer(
      directories,
      0,
      new Uint32Array([
        0, 4, 0, 0, 4, 3, 1, 1,
      ]) as unknown as GPUAllowSharedBufferSource,
    );
    pipeline = new GpuDescriptorPipeline(runtime, points);
    stage = "encode";
    pipeline.ensureCapacity(5, 2);
    const encoder = runtime.device.createCommandEncoder({
      label: "signalscope-descriptor-fixture",
    });
    const descriptorBytes = 8 * 16;
    const countOffset = descriptorBytes;
    const quadOffset = countOffset + 4;
    const hairlineOffset = quadOffset + 16;
    staging = runtime.device.createBuffer({
      label: "signalscope-descriptor-fixture-readback",
      size: hairlineOffset + 16,
      usage: 0x0001 | GPU_BUFFER_COPY_DST,
    });
    const buffers = pipeline.encode(encoder, directories, 5);
    encoder.copyBufferToBuffer(
      buffers.descriptors,
      0,
      staging,
      0,
      descriptorBytes,
    );
    encoder.copyBufferToBuffer(
      buffers.descriptorCount,
      0,
      staging,
      countOffset,
      4,
    );
    encoder.copyBufferToBuffer(buffers.quadArgs, 0, staging, quadOffset, 16);
    encoder.copyBufferToBuffer(
      buffers.hairlineArgs,
      0,
      staging,
      hairlineOffset,
      16,
    );
    stage = "submit";
    runtime.queue.submit([encoder.finish()]);
    stage = "readback";
    await new Promise<void>((resolve) =>
      globalThis.requestAnimationFrame(() => resolve()),
    );
    await staging.mapAsync(1);
    const raw = new Uint32Array(staging.getMappedRange()).slice();
    const descriptorCount = raw[countOffset / 4] ?? 0;
    return {
      descriptors: raw.slice(0, descriptorCount * 4),
      descriptorCount,
      quadArgs: raw.slice(quadOffset / 4, quadOffset / 4 + 4),
      hairlineArgs: raw.slice(hairlineOffset / 4, hairlineOffset / 4 + 4),
    };
  } catch (error) {
    throw new Error(`descriptor fixture ${stage}: ${String(error)}`);
  } finally {
    pipeline?.destroy();
    staging?.unmap();
    staging?.destroy();
    directories?.destroy();
    points?.destroy();
  }
}
