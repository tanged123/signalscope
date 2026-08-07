export const GPU_BUFFER_COPY_DST = 0x0008;
export const GPU_BUFFER_STORAGE = 0x0080;
const ALIGNMENT = 256;
const MiB = 1024 * 1024;
const MAX_PAGE_BYTES = 64 * MiB;
const MIN_PAGE_BYTES = 16 * MiB;

export interface ArenaLimits {
  readonly maxStorageBufferBindingSize: number;
  readonly maxBufferSize: number;
}

export interface ArenaSlice {
  readonly page: number;
  readonly offset: number;
  readonly size: number;
}

interface FreeBlock {
  offset: number;
  size: number;
}

interface Page {
  buffer: GPUBuffer;
  free: FreeBlock[];
}

export function arenaPageBytes(limits: ArenaLimits): number {
  const bytes = alignDown(
    Math.min(
      MAX_PAGE_BYTES,
      limits.maxStorageBufferBindingSize,
      limits.maxBufferSize,
    ),
    ALIGNMENT,
  );
  if (bytes < MIN_PAGE_BYTES) {
    throw new Error("WebGPU storage limits do not support a 16 MiB arena page");
  }
  return bytes;
}

export class GpuArena {
  readonly pageBytes: number;
  private readonly pages: Page[] = [];

  constructor(
    private readonly device: GPUDevice,
    private readonly queue: GPUQueue,
    limits: ArenaLimits,
  ) {
    this.pageBytes = arenaPageBytes(limits);
  }

  allocate(size: number): ArenaSlice {
    const aligned = alignUp(size, ALIGNMENT);
    if (!Number.isSafeInteger(aligned) || aligned <= 0) {
      throw new Error("GPU arena allocation must be positive");
    }
    if (aligned > this.pageBytes) {
      throw new Error("GPU arena allocation is larger than one page");
    }
    for (let page = 0; page < this.pages.length; page += 1) {
      const block = this.pages[page]?.free.find(
        (candidate) => candidate.size >= aligned,
      );
      if (block === undefined) continue;
      const offset = block.offset;
      block.offset += aligned;
      block.size -= aligned;
      if (block.size === 0)
        this.pages[page]?.free.splice(
          this.pages[page]?.free.indexOf(block) ?? 0,
          1,
        );
      return { page, offset, size: aligned };
    }
    const page = this.createPage();
    page.free = [{ offset: aligned, size: this.pageBytes - aligned }].filter(
      (block) => block.size > 0,
    );
    return { page: this.pages.length - 1, offset: 0, size: aligned };
  }

  release(slice: ArenaSlice): void {
    const page = this.pages[slice.page];
    if (
      page === undefined ||
      slice.offset < 0 ||
      slice.size <= 0 ||
      slice.offset + slice.size > this.pageBytes
    ) {
      throw new Error("invalid GPU arena slice");
    }
    page.free.push({ offset: slice.offset, size: slice.size });
    page.free.sort((left, right) => left.offset - right.offset);
    const merged: FreeBlock[] = [];
    for (const block of page.free) {
      const previous = merged[merged.length - 1];
      if (
        previous !== undefined &&
        previous.offset + previous.size === block.offset
      ) {
        previous.size += block.size;
      } else {
        merged.push({ ...block });
      }
    }
    page.free = merged;
  }

  write(slice: ArenaSlice, bytes: Uint8Array): void {
    if (bytes.byteLength > slice.size)
      throw new Error("GPU arena write exceeds slice");
    const page = this.pages[slice.page];
    if (page === undefined) throw new Error("invalid GPU arena page");
    this.queue.writeBuffer(
      page.buffer,
      slice.offset,
      bytes as unknown as GPUAllowSharedBufferSource,
    );
  }

  buffer(page: number): GPUBuffer {
    const entry = this.pages[page];
    if (entry === undefined) throw new Error("invalid GPU arena page");
    return entry.buffer;
  }

  freeBytes(page: number): number {
    const entry = this.pages[page];
    if (entry === undefined) return 0;
    return entry.free.reduce((total, block) => total + block.size, 0);
  }

  destroy(): void {
    this.pages.forEach((page) => page.buffer.destroy());
    this.pages.length = 0;
  }

  private createPage(): Page {
    const page: Page = {
      buffer: this.device.createBuffer({
        label: `signalscope-point-arena-${String(this.pages.length)}`,
        size: this.pageBytes,
        usage: GPU_BUFFER_STORAGE | GPU_BUFFER_COPY_DST,
      }),
      free: [{ offset: 0, size: this.pageBytes }],
    };
    this.pages.push(page);
    return page;
  }
}

function alignUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function alignDown(value: number, alignment: number): number {
  return Math.floor(value / alignment) * alignment;
}
