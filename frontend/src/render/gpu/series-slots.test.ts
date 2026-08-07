import { describe, expect, it, vi } from "vitest";
import { GpuSeriesSlots, type SeriesStyle } from "./series-slots";

const style: SeriesStyle = {
  rgba: [1, 0.5, 0.25, 1],
  widthDevicePx: 1.2,
  dash: "solid",
  visible: true,
  emphasized: false,
};

describe("GpuSeriesSlots", () => {
  it("keeps slots stable across style updates and reuses them by generation", () => {
    const slots = new GpuSeriesSlots();
    expect(slots.acquire("7", 1)).toBe(0);
    expect(slots.acquire("7", 1)).toBe(0);
    slots.setStyle("7", 1, style);
    slots.remove("7", 1);
    expect(slots.acquire("8", 1)).toBe(1);
    expect(slots.acquire("9", 2)).toBe(0);
  });

  it("uses one metadata buffer and coalesces adjacent writes", () => {
    const slots = new GpuSeriesSlots();
    slots.acquire("a", 1);
    slots.acquire("b", 1);
    slots.setStyle("a", 1, style);
    slots.setStyle("b", 1, style);
    const writeBuffer = vi.fn();
    const queue = { writeBuffer } as unknown as GPUQueue;
    const buffer = {} as GPUBuffer;
    slots.flush(queue, buffer);
    expect(writeBuffer).toHaveBeenCalledTimes(1);
    expect(slots.metadataStride).toBe(32);
  });
});
