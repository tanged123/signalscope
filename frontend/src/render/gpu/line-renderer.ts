import type { GpuRuntime } from "./runtime";
import type { GpuPanelEncoder } from "./frame-loop";
import { GPU_BUFFER_COPY_DST, GPU_BUFFER_STORAGE } from "./arena";
import type { GpuArena } from "./arena";
import {
  directoryFromResident,
  prepareSegmentDirectories,
  type SegmentDescriptor,
} from "./descriptor-builder";
import type { ResidentTile } from "./residency";
import type { SeriesStyle } from "./series-slots";
import { splitF64 } from "./precision";
import quadShader from "./shaders/line-quad.wgsl?raw";
import hairlineShader from "./shaders/line-hairline.wgsl?raw";

const GPU_BUFFER_UNIFORM = 0x0040;
const GPU_BUFFER_INDIRECT = 0x0100;

export interface LineViewport {
  readonly xMin: number;
  readonly xMax: number;
  readonly yMin: number;
  readonly yMax: number;
  readonly plotX: number;
  readonly plotY: number;
  readonly plotWidth: number;
  readonly plotHeight: number;
  readonly devicePixelRatio: number;
}

export interface LineMetrics {
  readonly pages: number;
  readonly drawCalls: number;
  readonly descriptors: number;
}

interface PageBuffers {
  descriptors: GPUBuffer;
  descriptorCapacity: number;
  descriptorCount: number;
  metadata: GPUBuffer;
  metadataCapacity: number;
  metadataCount: number;
  quadArgs: GPUBuffer;
  hairlineArgs: GPUBuffer;
}

interface TileMetadata {
  readonly pointStart: number;
  readonly pointCount: number;
  readonly originHigh: number;
  readonly originLow: number;
}

export class GpuLineRenderer implements GpuPanelEncoder {
  readonly id: string;
  readonly runtime: GpuRuntime;
  readonly context: GPUCanvasContext | undefined;
  private readonly arena: GpuArena | undefined;
  private viewport: LineViewport | null = null;
  private tiles: readonly ResidentTile[] = [];
  private styles: readonly SeriesStyle[] = [];
  private width = 1;
  private height = 1;
  private uniformBuffer: GPUBuffer | null = null;
  private styleBuffer: GPUBuffer | null = null;
  private styleCapacity = 0;
  private readonly pages = new Map<number, PageBuffers>();
  private lastMetrics: LineMetrics = { pages: 0, drawCalls: 0, descriptors: 0 };
  sceneDirty = false;
  transformDirty = false;
  styleDirty = false;
  residencyDirty = false;

  constructor(
    runtime: GpuRuntime,
    context: GPUCanvasContext | undefined,
    id: string,
    arena?: GpuArena,
  ) {
    this.runtime = runtime;
    this.context = context;
    this.id = id;
    this.arena = arena;
  }

  setViewport(viewport: LineViewport): void {
    this.viewport = viewport;
    this.transformDirty = true;
  }

  setTiles(tiles: readonly ResidentTile[]): void {
    const changed =
      tiles.length !== this.tiles.length ||
      tiles.some((tile, index) => tile.key !== this.tiles[index]?.key);
    this.tiles = tiles;
    this.residencyDirty ||= changed;
    this.sceneDirty ||= changed;
  }

  setStyles(styles: readonly SeriesStyle[]): void {
    this.styles = styles;
    this.styleDirty = true;
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, Math.trunc(width));
    this.height = Math.max(1, Math.trunc(height));
    this.transformDirty = true;
  }

  encode(encoder: GPUCommandEncoder): void {
    const pageIds = [...new Set(this.tiles.map((tile) => tile.points.page))];
    const descriptors = this.tiles.reduce(
      (total, tile) => total + Math.max(0, tile.pointCount - 1),
      0,
    );
    const dense = descriptors > this.width * this.height * 8;
    this.lastMetrics = {
      pages: pageIds.length,
      drawCalls: pageIds.length * (dense ? 2 : 1),
      descriptors,
    };

    if (
      this.context === undefined ||
      this.arena === undefined ||
      this.viewport === null ||
      pageIds.length === 0
    ) {
      this.clearDirty();
      return;
    }

    this.ensureUniformBuffer();
    this.writeUniform(dense);
    this.ensureStyleBuffer();
    if (this.styleDirty) this.writeStyles();
    if (this.residencyDirty) this.rebuildPages(pageIds);

    const view = this.context.getCurrentTexture().createView();
    const quadPipeline = this.quadPipeline();
    const quadPass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    quadPass.setPipeline(quadPipeline);
    for (const page of pageIds) {
      const buffers = this.pages.get(page);
      if (buffers === undefined || buffers.descriptorCount === 0) continue;
      quadPass.setBindGroup(0, this.bindGroup(quadPipeline, page, buffers));
      quadPass.drawIndirect(buffers.quadArgs, 0);
    }
    quadPass.end();

    if (dense) {
      const hairlinePipeline = this.hairlinePipeline();
      const hairlinePass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view,
            loadOp: "load",
            storeOp: "store",
          },
        ],
      });
      hairlinePass.setPipeline(hairlinePipeline);
      for (const page of pageIds) {
        const buffers = this.pages.get(page);
        if (buffers === undefined || buffers.descriptorCount === 0) continue;
        hairlinePass.setBindGroup(
          0,
          this.bindGroup(hairlinePipeline, page, buffers),
        );
        hairlinePass.drawIndirect(buffers.hairlineArgs, 0);
      }
      hairlinePass.end();
    }
    this.clearDirty();
  }

  afterSubmit(): void {}

  deviceLost(): void {
    this.sceneDirty = true;
  }

  deviceRestored(): void {
    this.uniformBuffer = null;
    this.styleBuffer = null;
    this.styleCapacity = 0;
    this.pages.clear();
    this.sceneDirty = true;
    this.residencyDirty = true;
  }

  metrics(): LineMetrics {
    return this.lastMetrics;
  }

  private clearDirty(): void {
    this.sceneDirty = false;
    this.transformDirty = false;
    this.styleDirty = false;
    this.residencyDirty = false;
  }

  private ensureUniformBuffer(): void {
    if (this.uniformBuffer !== null) return;
    this.uniformBuffer = this.runtime.device.createBuffer({
      label: `${this.id}-line-transform`,
      size: 48,
      usage: GPU_BUFFER_UNIFORM | GPU_BUFFER_COPY_DST,
    });
  }

  private writeUniform(dense: boolean): void {
    if (this.uniformBuffer === null || this.viewport === null) return;
    const viewOrigin = splitF64(this.viewport.xMin);
    const span = this.viewport.xMax - this.viewport.xMin;
    const ySpan = this.viewport.yMax - this.viewport.yMin;
    const values = new Float32Array([
      viewOrigin[0],
      viewOrigin[1],
      this.viewport.plotWidth / span,
      this.viewport.plotX,
      this.viewport.plotY,
      this.viewport.plotWidth,
      this.viewport.plotHeight,
      this.height,
      this.viewport.yMin,
      this.viewport.plotHeight / ySpan,
      dense ? 1 : 0,
      this.width,
    ]);
    this.runtime.queue.writeBuffer(
      this.uniformBuffer,
      0,
      values as unknown as GPUAllowSharedBufferSource,
    );
  }

  private ensureStyleBuffer(): void {
    const required = Math.max(1, this.styles.length);
    if (this.styleBuffer !== null && required <= this.styleCapacity) return;
    this.styleBuffer?.destroy();
    this.styleCapacity = nextCapacity(required);
    this.styleBuffer = this.runtime.device.createBuffer({
      label: `${this.id}-series-metadata`,
      size: this.styleCapacity * 32,
      usage: GPU_BUFFER_STORAGE | GPU_BUFFER_COPY_DST,
    });
    this.styleDirty = true;
  }

  private writeStyles(): void {
    if (this.styleBuffer === null) return;
    const bytes = new ArrayBuffer(this.styleCapacity * 32);
    const view = new DataView(bytes);
    for (let slot = 0; slot < this.styleCapacity; slot += 1) {
      const style = this.styles[slot] ?? defaultStyle();
      const offset = slot * 32;
      style.rgba.forEach((value, index) =>
        view.setFloat32(offset + index * 4, value, true),
      );
      view.setFloat32(offset + 16, style.widthDevicePx, true);
      view.setUint32(offset + 20, dashValue(style.dash), true);
      view.setUint32(
        offset + 24,
        (style.visible ? 1 : 0) | (style.emphasized ? 2 : 0),
        true,
      );
    }
    this.runtime.queue.writeBuffer(
      this.styleBuffer,
      0,
      new Uint8Array(bytes) as unknown as GPUAllowSharedBufferSource,
    );
  }

  private rebuildPages(pageIds: readonly number[]): void {
    const active = new Set(pageIds);
    for (const page of this.pages.keys()) {
      if (!active.has(page)) this.pages.delete(page);
    }
    for (const page of pageIds) {
      const pageTiles = this.tiles.filter((tile) => tile.points.page === page);
      const directories = prepareSegmentDirectories(
        pageTiles.map(directoryFromResident),
      );
      const descriptors = directories.flatMap((entry) => entry.candidates);
      const metadata = pageTiles.map((tile): TileMetadata => {
        const [originHigh, originLow] = splitF64(tile.origin);
        return {
          pointStart: tile.points.offset / 16,
          pointCount: tile.pointCount,
          originHigh,
          originLow,
        };
      });
      const buffers = this.pageBuffers(
        page,
        descriptors.length,
        metadata.length,
      );
      buffers.descriptorCount = descriptors.length;
      buffers.metadataCount = metadata.length;
      this.writeDescriptors(buffers.descriptors, descriptors);
      this.writeMetadata(buffers.metadata, metadata);
      this.writeIndirect(buffers.quadArgs, [6, descriptors.length, 0, 0]);
      this.writeIndirect(buffers.hairlineArgs, [
        descriptors.length * 2,
        1,
        0,
        0,
      ]);
    }
  }

  private pageBuffers(
    page: number,
    descriptorCount: number,
    metadataCount: number,
  ): PageBuffers {
    const existing = this.pages.get(page);
    if (
      existing !== undefined &&
      existing.descriptorCapacity >= descriptorCount &&
      existing.metadataCapacity >= metadataCount
    ) {
      return existing;
    }
    existing?.descriptors.destroy();
    existing?.metadata.destroy();
    existing?.quadArgs.destroy();
    existing?.hairlineArgs.destroy();
    const next: PageBuffers = {
      descriptors: this.runtime.device.createBuffer({
        label: `${this.id}-page-${String(page)}-descriptors`,
        size: Math.max(16, nextCapacity(descriptorCount) * 16),
        usage: GPU_BUFFER_STORAGE | GPU_BUFFER_COPY_DST,
      }),
      descriptorCapacity: nextCapacity(descriptorCount),
      descriptorCount: 0,
      metadata: this.runtime.device.createBuffer({
        label: `${this.id}-page-${String(page)}-tile-metadata`,
        size: Math.max(16, nextCapacity(metadataCount) * 16),
        usage: GPU_BUFFER_STORAGE | GPU_BUFFER_COPY_DST,
      }),
      metadataCapacity: nextCapacity(metadataCount),
      metadataCount: 0,
      quadArgs: this.runtime.device.createBuffer({
        label: `${this.id}-page-${String(page)}-quad-args`,
        size: 16,
        usage: GPU_BUFFER_STORAGE | GPU_BUFFER_COPY_DST | GPU_BUFFER_INDIRECT,
      }),
      hairlineArgs: this.runtime.device.createBuffer({
        label: `${this.id}-page-${String(page)}-hairline-args`,
        size: 16,
        usage: GPU_BUFFER_STORAGE | GPU_BUFFER_COPY_DST | GPU_BUFFER_INDIRECT,
      }),
    };
    this.pages.set(page, next);
    return next;
  }

  private writeDescriptors(
    buffer: GPUBuffer,
    descriptors: readonly SegmentDescriptor[],
  ): void {
    const values = new Uint32Array(Math.max(1, descriptors.length) * 4);
    descriptors.forEach((descriptor, index) => {
      values[index * 4] = descriptor.firstPoint;
      values[index * 4 + 1] = descriptor.secondPoint;
      values[index * 4 + 2] = descriptor.seriesSlot;
      values[index * 4 + 3] = descriptor.sourceOrder;
    });
    this.runtime.queue.writeBuffer(
      buffer,
      0,
      values as unknown as GPUAllowSharedBufferSource,
    );
  }

  private writeMetadata(
    buffer: GPUBuffer,
    metadata: readonly TileMetadata[],
  ): void {
    const values = new ArrayBuffer(Math.max(1, metadata.length) * 16);
    const view = new DataView(values);
    metadata.forEach((entry, index) => {
      const offset = index * 16;
      view.setUint32(offset, entry.pointStart, true);
      view.setUint32(offset + 4, entry.pointCount, true);
      view.setFloat32(offset + 8, entry.originHigh, true);
      view.setFloat32(offset + 12, entry.originLow, true);
    });
    this.runtime.queue.writeBuffer(
      buffer,
      0,
      new Uint8Array(values) as unknown as GPUAllowSharedBufferSource,
    );
  }

  private writeIndirect(buffer: GPUBuffer, values: readonly number[]): void {
    this.runtime.queue.writeBuffer(
      buffer,
      0,
      new Uint32Array(values) as unknown as GPUAllowSharedBufferSource,
    );
  }

  private bindGroup(
    pipeline: GPURenderPipeline,
    page: number,
    buffers: PageBuffers,
  ): GPUBindGroup {
    if (this.uniformBuffer === null || this.styleBuffer === null)
      throw new Error("line renderer buffers are not initialized");
    if (this.arena === undefined)
      throw new Error("line renderer arena missing");
    return this.runtime.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.arena.buffer(page) } },
        { binding: 2, resource: { buffer: buffers.descriptors } },
        { binding: 3, resource: { buffer: this.styleBuffer } },
        { binding: 4, resource: { buffer: buffers.metadata } },
      ],
    });
  }

  private quadPipeline(): GPURenderPipeline {
    return this.runtime.renderPipeline("line-quad", () =>
      this.runtime.device.createRenderPipeline({
        layout: "auto",
        vertex: {
          module: this.runtime.shader("line-quad", quadShader),
          entryPoint: "vs_main",
        },
        fragment: {
          module: this.runtime.shader("line-quad", quadShader),
          entryPoint: "fs_main",
          targets: [{ format: this.runtime.format }],
        },
        primitive: { topology: "triangle-list" },
      }),
    );
  }

  private hairlinePipeline(): GPURenderPipeline {
    return this.runtime.renderPipeline("line-hairline", () =>
      this.runtime.device.createRenderPipeline({
        layout: "auto",
        vertex: {
          module: this.runtime.shader("line-hairline", hairlineShader),
          entryPoint: "vs_main",
        },
        fragment: {
          module: this.runtime.shader("line-hairline", hairlineShader),
          entryPoint: "fs_main",
          targets: [{ format: this.runtime.format }],
        },
        primitive: { topology: "line-list" },
      }),
    );
  }
}

function nextCapacity(required: number): number {
  let capacity = 1;
  while (capacity < required) capacity *= 2;
  return capacity;
}

function dashValue(dash: SeriesStyle["dash"]): number {
  return dash === "solid" ? 0 : dash === "dash" ? 1 : 2;
}

function defaultStyle(): SeriesStyle {
  return {
    rgba: [1, 1, 1, 1],
    widthDevicePx: 1,
    dash: "solid",
    visible: true,
    emphasized: false,
  };
}
