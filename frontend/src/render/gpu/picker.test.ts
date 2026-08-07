import { describe, expect, it, vi } from "vitest";
import {
  GpuPicker,
  nearestCpuPick,
  type PickSeries,
  type PickRequest,
} from "./picker";

const request = (sequence: number, explicit = false): PickRequest => ({
  sequence,
  cursorX: 10,
  cursorY: 10,
  radius: 5,
  explicit,
});

describe("GpuPicker", () => {
  it("replaces pending hover work above 30 Hz without allocating a slot", async () => {
    let now = 0;
    const picker = new GpuPicker(undefined, () => now);
    const first = picker.request(request(1));
    now = 10;
    const second = picker.request(request(2));
    await expect(first).resolves.toBeNull();
    picker.encode({} as GPUCommandEncoder);
    picker.complete(2, {
      sequence: 2,
      seriesSlot: 0,
      time: 1,
      value: 2,
      distance: 0,
    });
    await expect(second).resolves.toMatchObject({ sequence: 2 });
  });

  it("keeps the newest completed sequence when readback completes out of order", async () => {
    const picker = new GpuPicker(undefined, () => 1000);
    const first = picker.request(request(7, true));
    const second = picker.request(request(8, true));
    picker.encode({} as GPUCommandEncoder);
    picker.encode({} as GPUCommandEncoder);
    picker.complete(8, {
      sequence: 8,
      seriesSlot: 2,
      time: 1,
      value: 2,
      distance: 1,
    });
    picker.complete(7, {
      sequence: 7,
      seriesSlot: 1,
      time: 0,
      value: 1,
      distance: 0,
    });
    await expect(second).resolves.toMatchObject({ sequence: 8 });
    await expect(first).resolves.toMatchObject({ sequence: 7 });
    expect(picker.latest()?.sequence).toBe(8);
  });

  it("keeps explicit work queued when all three readback slots are busy", async () => {
    const picker = new GpuPicker(undefined, () => 1000);
    const requests = [1, 2, 3, 4].map((sequence) =>
      picker.request(request(sequence, true)),
    );
    picker.encode({} as GPUCommandEncoder);
    picker.encode({} as GPUCommandEncoder);
    picker.encode({} as GPUCommandEncoder);
    picker.encode({} as GPUCommandEncoder);
    picker.complete(1, null);
    picker.encode({} as GPUCommandEncoder);
    picker.complete(4, null);
    await expect(requests[0]).resolves.toBeNull();
    await expect(requests[3]).resolves.toBeNull();
  });

  it("does not await mapping from encode", () => {
    const mapAsync = vi.fn(() => new Promise<void>(() => undefined));
    const picker = new GpuPicker({
      createBuffer: vi.fn(() => ({ mapAsync })),
    } as unknown as GPUDevice);
    void picker.request(request(1, true));
    picker.encode({} as GPUCommandEncoder);
    expect(mapAsync).not.toHaveBeenCalled();
  });
});

describe("nearestCpuPick", () => {
  const series: PickSeries[] = [
    {
      seriesSlot: 2,
      visible: true,
      points: [
        { time: 0, value: 0, breakBefore: false },
        { time: 10, value: 10, breakBefore: false },
      ],
    },
    {
      seriesSlot: 1,
      visible: true,
      points: [
        { time: 0, value: 10, breakBefore: false },
        { time: 10, value: 0, breakBefore: false },
      ],
    },
  ];
  const project = (time: number, value: number): { x: number; y: number } => ({
    x: time,
    y: value,
  });

  it("interpolates adjacent ordered points and breaks ties by series slot", () => {
    const result = nearestCpuPick(
      { cursorTime: 5, cursorX: 5, cursorY: 5, radius: 1 },
      series,
      project,
    );
    expect(result).toMatchObject({ seriesSlot: 1, time: 5, value: 5 });
  });

  it("refuses gaps, hidden series, and points outside the radius", () => {
    const base = series[0];
    if (base === undefined) throw new Error("test series missing");
    const gapped: PickSeries[] = [
      {
        seriesSlot: 0,
        visible: true,
        points: [
          { time: 0, value: 0, breakBefore: false },
          { time: 10, value: 10, breakBefore: true },
        ],
      },
      { ...base, seriesSlot: 1, visible: false },
    ];
    expect(
      nearestCpuPick(
        { cursorTime: 5, cursorX: 5, cursorY: 5, radius: 1 },
        gapped,
        project,
      ),
    ).toBeNull();
    expect(
      nearestCpuPick(
        { cursorTime: 5, cursorX: 5, cursorY: 50, radius: 1 },
        series,
        project,
      ),
    ).toBeNull();
  });
});
