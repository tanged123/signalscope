import { describe, expect, it } from "vitest";
import type { SampleSeries } from "../generated/protocol";
import { spectrum } from "./spectrum";

function sampled(rate: number, seconds: number, tone: number): SampleSeries {
  const count = Math.round(rate * seconds);
  const time: number[] = [];
  const values: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const t = index / rate;
    time.push(t);
    values.push(Math.sin(2 * Math.PI * tone * t));
  }
  return {
    signal_id: "1",
    signal_path: "imu/accel_z",
    unit: "m/s^2",
    time,
    values,
    stride: 1,
  };
}

describe("spectrum", () => {
  it("peaks at the tone frequency", () => {
    const result = spectrum(sampled(256, 4, 16), 0, 4 - 1 / 256);
    expect(result).not.toBeNull();
    if (result === null) return;
    const peak = result.amplitudeDb.indexOf(0);
    expect(peak).toBeGreaterThanOrEqual(0);
    expect(result.frequency[peak] ?? 0).toBeCloseTo(16, 0);
  });

  it("normalizes the peak to 0 dB and floors the noise", () => {
    const result = spectrum(sampled(256, 4, 16), 0, 4 - 1 / 256);
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(Math.max(...result.amplitudeDb)).toBe(0);
    expect(Math.min(...result.amplitudeDb)).toBeGreaterThanOrEqual(-120);
  });

  it("drops DC and uses a power-of-two grid", () => {
    const result = spectrum(sampled(256, 4, 16), 0, 4 - 1 / 256);
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.frequency[0] ?? 0).toBeGreaterThan(0);
    expect(result.size & (result.size - 1)).toBe(0);
    expect(result.frequency).toHaveLength(result.size / 2);
  });

  it("returns null for a window with too few samples", () => {
    const series = sampled(256, 4, 16);
    expect(spectrum(series, 0, 0.1)).toBeNull();
  });

  it("uses the available power-of-two samples below the transform cap", () => {
    const series = sampled(8192, 1, 16);
    const result = spectrum(series, 0, 8191 / 8192);
    expect(result).not.toBeNull();
    expect(result?.size).toBe(8192);
  });

  it("uses a transform larger than the legacy 4096 cap when samples allow", () => {
    const count = 40_000;
    const time = Array.from({ length: count }, (_, index) => index / 1000);
    const values = time.map((t) => Math.sin(2 * Math.PI * 50 * t));
    const result = spectrum(
      { signal_id: "1", signal_path: "a", unit: null, time, values, stride: 1 },
      time[0] ?? 0,
      time[count - 1] ?? 0,
    );
    expect(result).not.toBeNull();
    expect(result?.size).toBe(16_384);
  });
});
