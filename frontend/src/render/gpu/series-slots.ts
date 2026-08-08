import { GPU_BUFFER_COPY_DST, GPU_BUFFER_STORAGE } from "./arena";

export interface SeriesStyle {
  readonly rgba: readonly [number, number, number, number];
  readonly widthDevicePx: number;
  readonly dash: "solid" | "dash" | "dot";
  readonly visible: boolean;
  readonly emphasized: boolean;
}

interface RecordEntry {
  signalId: string;
  generation: number;
  style: SeriesStyle;
}

export class GpuSeriesSlots {
  readonly metadataStride = 32;
  private readonly records = new Map<string, RecordEntry>();
  private readonly slots = new Map<string, number>();
  private readonly released = new Map<number, number>();
  private readonly dirty = new Set<number>();
  private nextSlot = 0;
  private bytes = new Uint8Array();
  private buffer: GPUBuffer | null = null;

  acquire(signalId: string, generation: number): number {
    const current = this.records.get(signalId);
    if (current !== undefined) {
      current.generation = generation;
      return this.slotOf(signalId);
    }
    const reusable = [...this.released.entries()]
      .filter(([, releasedGeneration]) => releasedGeneration < generation)
      .sort(([left], [right]) => left - right)[0];
    const slot = reusable?.[0] ?? this.nextSlot++;
    if (reusable !== undefined) this.released.delete(reusable[0]);
    this.ensureBytes(slot + 1);
    this.records.set(signalId, {
      signalId,
      generation,
      style: defaultStyle(),
    });
    this.slots.set(signalId, slot);
    this.writeStyle(slot, defaultStyle());
    this.dirty.add(slot);
    return slot;
  }

  remove(signalId: string, generation: number): number | null {
    const slot = this.records.get(signalId);
    if (slot === undefined) return null;
    const index = this.slotOf(signalId);
    this.released.set(index, generation);
    this.records.delete(signalId);
    this.slots.delete(signalId);
    return index;
  }

  slotOf(signalId: string): number {
    const slot = this.slots.get(signalId);
    if (slot === undefined) throw new Error("unknown GPU series slot");
    return slot;
  }

  setStyle(signalId: string, generation: number, style: SeriesStyle): void {
    const slot = this.records.get(signalId);
    if (slot === undefined || slot.generation !== generation) {
      throw new Error("series style generation is stale");
    }
    slot.style = style;
    const index = this.slotOf(signalId);
    this.writeStyle(index, style);
    this.dirty.add(index);
  }

  createBuffer(device: GPUDevice): GPUBuffer {
    if (this.buffer === null) {
      this.buffer = device.createBuffer({
        label: "signalscope-series-metadata",
        size: Math.max(this.metadataStride, this.bytes.byteLength),
        usage: GPU_BUFFER_STORAGE | GPU_BUFFER_COPY_DST,
      });
    }
    return this.buffer;
  }

  flush(queue: GPUQueue, buffer: GPUBuffer): void {
    const dirty = [...this.dirty].sort((left, right) => left - right);
    let start: number | null = null;
    let end = 0;
    for (const slot of dirty) {
      if (start === null) start = slot;
      if (slot > end + 1) {
        queue.writeBuffer(
          buffer,
          start * this.metadataStride,
          this.bytes.subarray(
            start * this.metadataStride,
            (end + 1) * this.metadataStride,
          ),
        );
        start = slot;
      }
      end = slot;
    }
    if (start !== null) {
      queue.writeBuffer(
        buffer,
        start * this.metadataStride,
        this.bytes.subarray(
          start * this.metadataStride,
          (end + 1) * this.metadataStride,
        ),
      );
    }
    this.dirty.clear();
  }

  private ensureBytes(count: number): void {
    if (this.bytes.byteLength >= count * this.metadataStride) return;
    const bytes = new Uint8Array(count * this.metadataStride);
    bytes.set(this.bytes);
    this.bytes = bytes;
  }

  private writeStyle(slot: number, style: SeriesStyle): void {
    this.ensureBytes(slot + 1);
    const view = new DataView(this.bytes.buffer);
    const offset = slot * this.metadataStride;
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
    view.setUint32(offset + 28, 0, true);
  }
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
