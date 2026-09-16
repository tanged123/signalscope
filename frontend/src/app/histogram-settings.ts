import type { PanelContent } from "../generated/session";

export const DEFAULT_HISTOGRAM_BIN_COUNT = 32;
export const MIN_HISTOGRAM_BIN_COUNT = 1;
export const MAX_HISTOGRAM_BIN_COUNT = 256;

export function validateHistogramBinCount(value: number): number {
  if (
    !Number.isInteger(value) ||
    value < MIN_HISTOGRAM_BIN_COUNT ||
    value > MAX_HISTOGRAM_BIN_COUNT
  ) {
    throw new RangeError(
      `Histogram bin count must be an integer between ${String(MIN_HISTOGRAM_BIN_COUNT)} and ${String(MAX_HISTOGRAM_BIN_COUNT)}`,
    );
  }
  return value;
}

export function validatePanelContent(content: PanelContent): PanelContent {
  if (content.kind !== "histogram") return { ...content };
  return {
    ...content,
    bin_count: validateHistogramBinCount(content.bin_count),
  };
}
