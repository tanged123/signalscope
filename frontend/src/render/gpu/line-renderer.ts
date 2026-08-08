import type { GpuRuntime } from "./runtime";
import type { GpuPanelEncoder } from "./frame-loop";
import { GPU_BUFFER_COPY_DST, GPU_BUFFER_STORAGE } from "./arena";
import type { GpuArena } from "./arena";
import {
  directoryFromResident,
  prepareSegmentDirectories,
  tileDirectoryFromPrepared,
  type TileDirectory,
} from "./descriptor-builder";
import { GpuDescriptorPipeline } from "./descriptor-pipeline";
import { type GpuResidency, type ResidentTile } from "./residency";
import type { SeriesStyle } from "./series-slots";
import { splitF64 } from "./precision";
import {
  GpuPicker,
  type PickPage,
  type PickRequest,
  type PickResult,
  type PickViewport,
} from "./picker";
import type { GpuMetrics } from "./metrics";
import { PanelRenderTargets, PANEL_MSAA_SAMPLE_COUNT } from "./render-targets";
import quadShader from "./shaders/line-quad.wgsl?raw";
import hairlineShader from "./shaders/line-hairline.wgsl?raw";

const GPU_BUFFER_UNIFORM = 0x0040;
const HAIRLINE_SAMPLE_COUNT = 1;

export const PREMULTIPLIED_ALPHA_BLEND: GPUBlendState = {
  color: {
    srcFactor: "one",
    dstFactor: "one-minus-src-alpha",
    operation: "add",
  },
  alpha: {
    srcFactor: "one",
    dstFactor: "one-minus-src-alpha",
    operation: "add",
  },
};

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

export interface PlotScissor {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function plotScissor(
  viewport: Pick<LineViewport, "plotX" | "plotY" | "plotWidth" | "plotHeight">,
  canvasWidth: number,
  canvasHeight: number,
): PlotScissor {
  const left = clampPixel(viewport.plotX, canvasWidth);
  const top = clampPixel(viewport.plotY, canvasHeight);
  const right = clampPixel(viewport.plotX + viewport.plotWidth, canvasWidth);
  const bottom = clampPixel(viewport.plotY + viewport.plotHeight, canvasHeight);
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

interface PageBuffers {
  descriptors: GPUBuffer | null;
  descriptorCapacity: number;
  descriptorCount: number;
  directories: GPUBuffer;
  directoryCapacity: number;
  descriptorPipeline: GpuDescriptorPipeline;
  metadata: GPUBuffer;
  metadataCapacity: number;
  metadataCount: number;
  tileOrigins: readonly number[];
  quadArgs: GPUBuffer | null;
  hairlineArgs: GPUBuffer | null;
  pickRanges: GPUBuffer;
  pickRangeCapacity: number;
  pickRangeCount: number;
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
  readonly picker: GpuPicker;
  private readonly renderTargets = new PanelRenderTargets();
  private readonly arena: GpuArena | undefined;
  private readonly residency: GpuResidency | undefined;
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
    residency?: GpuResidency,
  ) {
    this.runtime = runtime;
    this.context = context;
    this.id = id;
    this.arena = arena;
    this.residency = residency;
    this.picker = new GpuPicker(runtime);
    this.picker.setScheduler({
      requestFrame: () => runtime.requestFrame(this),
    });
    if (context !== undefined) {
      this.renderTargets.configure(runtime.device, context, runtime.format);
    }
  }

  setViewport(viewport: LineViewport): void {
    this.viewport = viewport;
    this.picker.setViewport(toPickViewport(viewport, this.width, this.height));
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
    const nextWidth = Math.max(1, Math.trunc(width));
    const nextHeight = Math.max(1, Math.trunc(height));
    this.width = nextWidth;
    this.height = nextHeight;
    this.renderTargets.resize(nextWidth, nextHeight);
    this.transformDirty = true;
  }

  encode(encoder: GPUCommandEncoder): void {
    if (
      !this.sceneDirty &&
      !this.transformDirty &&
      !this.styleDirty &&
      !this.residencyDirty
    ) {
      return;
    }
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
    this.gpuMetrics()?.recordDraw(this.lastMetrics.drawCalls);
    this.gpuMetrics()?.recordSegments(descriptors);

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
    if (this.residencyDirty) this.rebuildPages(pageIds, encoder);
    this.picker.encode(encoder);

    const targets = this.renderTargets.frame();
    const scissor = plotScissor(this.viewport, this.width, this.height);
    const quadPipeline = this.quadPipeline();
    const quadPass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: targets.msaa,
          resolveTarget: targets.swapchain,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    quadPass.setPipeline(quadPipeline);
    setScissor(quadPass, scissor);
    for (const page of pageIds) {
      const buffers = this.pages.get(page);
      if (
        buffers === undefined ||
        buffers.descriptorCount === 0 ||
        buffers.descriptors === null ||
        buffers.quadArgs === null
      )
        continue;
      setScissor(quadPass, scissor);
      quadPass.setBindGroup(0, this.bindGroup(quadPipeline, page, buffers));
      quadPass.drawIndirect(buffers.quadArgs, 0);
    }
    quadPass.end();

    if (dense) {
      const hairlinePipeline = this.hairlinePipeline();
      const hairlinePass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: targets.swapchain,
            loadOp: "load",
            storeOp: "store",
          },
        ],
      });
      hairlinePass.setPipeline(hairlinePipeline);
      setScissor(hairlinePass, scissor);
      for (const page of pageIds) {
        const buffers = this.pages.get(page);
        if (
          buffers === undefined ||
          buffers.descriptorCount === 0 ||
          buffers.descriptors === null ||
          buffers.hairlineArgs === null
        )
          continue;
        setScissor(hairlinePass, scissor);
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

  afterSubmit(): void {
    this.picker.afterSubmit();
  }

  requestPick(request: PickRequest): Promise<PickResult | null> {
    const result = this.picker.request(request);
    this.runtime.requestFrame(this);
    return result;
  }

  latestPick(): PickResult | null {
    return this.picker.latest();
  }

  pickTime(result: PickResult): number | null {
    return this.picker.resolveTime(result);
  }

  deviceLost(): void {
    this.renderTargets.destroy();
    this.arena?.destroy();
    this.residency?.dropDevice();
    this.tiles = [];
    this.picker.setScene([]);
    this.sceneDirty = true;
  }

  deviceRestored(device: GPUDevice): void {
    this.arena?.restore(device, this.runtime.queue);
    if (this.context !== undefined) {
      this.renderTargets.configure(device, this.context, this.runtime.format);
      this.renderTargets.resize(this.width, this.height);
    }
    this.picker.resetDevice(this.runtime);
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

  private rebuildPages(
    pageIds: readonly number[],
    encoder: GPUCommandEncoder,
  ): void {
    const active = new Set(pageIds);
    for (const page of this.pages.keys()) {
      if (!active.has(page)) {
        const buffers = this.pages.get(page);
        buffers?.descriptorPipeline.destroy();
        buffers?.directories.destroy();
        this.pages.delete(page);
      }
    }
    for (const page of pageIds) {
      const pageTiles = this.tiles.filter((tile) => tile.points.page === page);
      const prepared = prepareSegmentDirectories(
        pageTiles.map(directoryFromResident),
      );
      const directories = prepared.map(tileDirectoryFromPrepared);
      const tilesByPointStart = new Map(
        pageTiles.map((tile) => [tile.points.offset / 16, tile]),
      );
      const orderedTiles = prepared
        .map((entry) => tilesByPointStart.get(entry.pointOffset))
        .filter((tile): tile is ResidentTile => tile !== undefined);
      const candidateCount = directories.reduce(
        (total, directory) => total + Math.max(0, directory.pointCount - 1),
        0,
      );
      const metadata = orderedTiles.map((tile): TileMetadata => {
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
        candidateCount,
        directories.length,
        metadata.length,
        orderedTiles.length,
      );
      buffers.descriptorCount = candidateCount;
      buffers.metadataCount = metadata.length;
      buffers.tileOrigins = orderedTiles.map((tile) => tile.origin);
      buffers.pickRangeCount = orderedTiles.length;
      buffers.descriptorPipeline.ensureCapacity(
        candidateCount,
        directories.length,
      );
      this.writeDirectories(buffers.directories, directories);
      this.writeMetadata(buffers.metadata, metadata);
      this.writePickRanges(buffers.pickRanges, orderedTiles);
      const built = buffers.descriptorPipeline.encode(
        encoder,
        buffers.directories,
        candidateCount,
      );
      buffers.descriptors = built.descriptors;
      buffers.quadArgs = built.quadArgs;
      buffers.hairlineArgs = built.hairlineArgs;
      this.gpuMetrics()?.recordDescriptorRebuild();
    }
    const pickerPages: PickPage[] = [];
    let tileMetaBase = 0;
    for (const page of pageIds) {
      const buffers = this.pages.get(page);
      if (buffers === undefined || this.arena === undefined) continue;
      pickerPages.push({
        pointBuffer: this.arena.buffer(page),
        rangeBuffer: buffers.pickRanges,
        metadataBuffer: buffers.metadata,
        styleBuffer: this.styleBuffer as GPUBuffer,
        seriesCount: buffers.pickRangeCount,
        tileMetaBase,
        tileOrigins: buffers.tileOrigins,
      });
      tileMetaBase += buffers.metadataCount;
    }
    this.picker.setScene(pickerPages);
  }

  private pageBuffers(
    page: number,
    descriptorCount: number,
    directoryCount: number,
    metadataCount: number,
    pickRangeCount: number,
  ): PageBuffers {
    const existing = this.pages.get(page);
    if (
      existing !== undefined &&
      existing.descriptorCapacity >= descriptorCount &&
      existing.directoryCapacity >= directoryCount &&
      existing.metadataCapacity >= metadataCount &&
      existing.pickRangeCapacity >= pickRangeCount
    ) {
      return existing;
    }
    existing?.descriptorPipeline.destroy();
    existing?.directories.destroy();
    existing?.metadata.destroy();
    existing?.pickRanges.destroy();
    const directoryCapacity = nextCapacity(directoryCount);
    const next: PageBuffers = {
      descriptors: null,
      quadArgs: null,
      hairlineArgs: null,
      directories: this.runtime.device.createBuffer({
        label: `${this.id}-page-${String(page)}-directories`,
        size: Math.max(16, directoryCapacity * 16),
        usage: GPU_BUFFER_STORAGE | GPU_BUFFER_COPY_DST,
      }),
      descriptorCapacity: nextCapacity(descriptorCount),
      directoryCapacity,
      descriptorCount: 0,
      descriptorPipeline: new GpuDescriptorPipeline(
        this.runtime,
        this.arena?.buffer(page) ??
          (() => {
            throw new Error("line renderer arena missing");
          })(),
      ),
      metadata: this.runtime.device.createBuffer({
        label: `${this.id}-page-${String(page)}-tile-metadata`,
        size: Math.max(16, nextCapacity(metadataCount) * 16),
        usage: GPU_BUFFER_STORAGE | GPU_BUFFER_COPY_DST,
      }),
      metadataCapacity: nextCapacity(metadataCount),
      metadataCount: 0,
      tileOrigins: [],
      pickRanges: this.runtime.device.createBuffer({
        label: `${this.id}-page-${String(page)}-pick-ranges`,
        size: Math.max(16, nextCapacity(pickRangeCount) * 16),
        usage: GPU_BUFFER_STORAGE | GPU_BUFFER_COPY_DST,
      }),
      pickRangeCapacity: nextCapacity(pickRangeCount),
      pickRangeCount: 0,
    };
    this.pages.set(page, next);
    return next;
  }

  private writeDirectories(
    buffer: GPUBuffer,
    directories: readonly TileDirectory[],
  ): void {
    const values = new Uint32Array(Math.max(1, directories.length) * 4);
    directories.forEach((directory, index) => {
      values[index * 4] = directory.pointStart;
      values[index * 4 + 1] = directory.pointCount;
      values[index * 4 + 2] = directory.seriesSlot;
      values[index * 4 + 3] = directory.tileMetaIndex;
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

  private writePickRanges(
    buffer: GPUBuffer,
    tiles: readonly ResidentTile[],
  ): void {
    const values = new Uint32Array(Math.max(1, tiles.length) * 4);
    tiles.forEach((tile, index) => {
      const offset = index * 4;
      values[offset] = tile.points.offset / 16;
      values[offset + 1] = tile.pointCount;
      values[offset + 2] = tile.seriesSlot;
      values[offset + 3] = index;
    });
    this.runtime.queue.writeBuffer(
      buffer,
      0,
      values as unknown as GPUAllowSharedBufferSource,
    );
  }

  private gpuMetrics(): GpuMetrics | null {
    return (
      (this.runtime as unknown as { metrics?: GpuMetrics }).metrics ?? null
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
    if (buffers.descriptors === null)
      throw new Error("line renderer descriptors are not initialized");
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
          targets: [
            {
              format: this.runtime.format,
              blend: PREMULTIPLIED_ALPHA_BLEND,
            },
          ],
        },
        primitive: { topology: "triangle-list" },
        multisample: { count: PANEL_MSAA_SAMPLE_COUNT },
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
          targets: [
            {
              format: this.runtime.format,
              blend: PREMULTIPLIED_ALPHA_BLEND,
            },
          ],
        },
        primitive: { topology: "line-list" },
        multisample: { count: HAIRLINE_SAMPLE_COUNT },
      }),
    );
  }
}

function toPickViewport(
  viewport: LineViewport,
  canvasWidth: number,
  canvasHeight: number,
): PickViewport {
  const origin = splitF64(viewport.xMin);
  return {
    viewOriginHigh: origin[0],
    viewOriginLow: origin[1],
    timeScale: viewport.plotWidth / (viewport.xMax - viewport.xMin),
    plotX: viewport.plotX,
    plotY: viewport.plotY,
    plotWidth: viewport.plotWidth,
    plotHeight: viewport.plotHeight,
    canvasHeight,
    yMin: viewport.yMin,
    yScale: viewport.plotHeight / (viewport.yMax - viewport.yMin),
    canvasWidth,
  };
}

function nextCapacity(required: number): number {
  let capacity = 1;
  while (capacity < required) capacity *= 2;
  return capacity;
}

function clampPixel(value: number, limit: number): number {
  return Math.max(0, Math.min(limit, Math.round(value)));
}

function setScissor(pass: GPURenderPassEncoder, scissor: PlotScissor): void {
  pass.setScissorRect(scissor.x, scissor.y, scissor.width, scissor.height);
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
