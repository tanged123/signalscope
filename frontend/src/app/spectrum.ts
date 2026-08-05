import type { SampleSeries } from "../generated/protocol";
import { lerpSample } from "./xy";

export interface Spectrum {
  /** Bin centre frequencies in Hz, one-sided and DC-free. */
  frequency: number[];
  /** Magnitude in dB relative to the peak bin, floored. */
  amplitudeDb: number[];
  /** The uniform rate the window was resampled onto. */
  sampleRate: number;
  /** Transform size (a power of two). */
  size: number;
}

const MIN_SIZE = 64;
const MAX_SIZE = 16_384;
const FLOOR_DB = -120;

function largestPowerOfTwoAtMost(value: number): number {
  let size = MIN_SIZE;
  while (size * 2 <= value && size * 2 <= MAX_SIZE) size *= 2;
  return size;
}

/** In-place iterative radix-2 Cooley–Tukey transform; `real.length` is 2^k. */
function transform(real: Float64Array, imaginary: Float64Array): void {
  const count = real.length;
  for (let index = 1, mirror = 0; index < count; index += 1) {
    let bit = count >> 1;
    for (; (mirror & bit) !== 0; bit >>= 1) mirror ^= bit;
    mirror ^= bit;
    if (index < mirror) {
      const swapReal = real[index] ?? 0;
      const swapImaginary = imaginary[index] ?? 0;
      real[index] = real[mirror] ?? 0;
      imaginary[index] = imaginary[mirror] ?? 0;
      real[mirror] = swapReal;
      imaginary[mirror] = swapImaginary;
    }
  }
  for (let span = 2; span <= count; span <<= 1) {
    const angle = (-2 * Math.PI) / span;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    const half = span >> 1;
    for (let start = 0; start < count; start += span) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      for (let offset = 0; offset < half; offset += 1) {
        const low = start + offset;
        const high = low + half;
        const highReal = real[high] ?? 0;
        const highImaginary = imaginary[high] ?? 0;
        const productReal =
          highReal * twiddleReal - highImaginary * twiddleImaginary;
        const productImaginary =
          highReal * twiddleImaginary + highImaginary * twiddleReal;
        const lowReal = real[low] ?? 0;
        const lowImaginary = imaginary[low] ?? 0;
        real[low] = lowReal + productReal;
        imaginary[low] = lowImaginary + productImaginary;
        real[high] = lowReal - productReal;
        imaginary[high] = lowImaginary - productImaginary;
        const nextReal =
          twiddleReal * stepReal - twiddleImaginary * stepImaginary;
        twiddleImaginary =
          twiddleReal * stepImaginary + twiddleImaginary * stepReal;
        twiddleReal = nextReal;
      }
    }
  }
}

/**
 * The one-sided amplitude spectrum of a signal over `[t0, t1]`.
 *
 * Returns null when the window holds too few samples to transform, when it
 * is degenerate, or when resampling hits a gap — a spectrum computed across
 * absent data would be a fabrication, and the pyramid's gap invariants
 * commit this codebase to refusing rather than interpolating over one.
 *
 * ADR 0017 records every semantic choice here.
 */
export function spectrum(
  series: SampleSeries,
  t0: number,
  t1: number,
): Spectrum | null {
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return null;
  let inWindow = 0;
  for (const time of series.time) {
    if (time >= t0 && time <= t1) inWindow += 1;
  }
  if (inWindow < MIN_SIZE) return null;
  const size = largestPowerOfTwoAtMost(inWindow);
  const step = (t1 - t0) / (size - 1);
  const real = new Float64Array(size);
  const imaginary = new Float64Array(size);
  let mean = 0;
  for (let index = 0; index < size; index += 1) {
    const value = lerpSample(series.time, series.values, t0 + step * index);
    if (!Number.isFinite(value)) return null;
    real[index] = value;
    mean += value;
  }
  mean /= size;
  for (let index = 0; index < size; index += 1) {
    const hann = 0.5 * (1 - Math.cos((2 * Math.PI * index) / (size - 1)));
    real[index] = ((real[index] ?? 0) - mean) * hann;
  }
  transform(real, imaginary);
  const bins = size >> 1;
  const magnitude: number[] = [];
  let peak = 0;
  for (let index = 1; index <= bins; index += 1) {
    const value = Math.hypot(real[index] ?? 0, imaginary[index] ?? 0);
    magnitude.push(value);
    if (value > peak) peak = value;
  }
  const sampleRate = (size - 1) / (t1 - t0);
  const frequency = magnitude.map(
    (_, index) => ((index + 1) * sampleRate) / size,
  );
  const amplitudeDb = magnitude.map((value) => {
    if (peak <= 0 || value <= 0) return FLOOR_DB;
    return Math.max(FLOOR_DB, 20 * Math.log10(value / peak));
  });
  return { frequency, amplitudeDb, sampleRate, size };
}
