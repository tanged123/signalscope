import { createFeedCache } from "./line2d-adapter";

/** Reflect display coordinates without changing row order, gaps, or color attributes. */
export function createDirectedFeed() {
  const feeds = createFeedCache<Float32Array, number, Float32Array>(
    (a, b) => a === b,
  );
  return (
    data: Float32Array,
    xReversed = false,
    yReversed = false,
  ): Float32Array => {
    const direction = Number(xReversed) + 2 * Number(yReversed);
    if (direction === 0) return data;
    return feeds(data, direction, () => {
      const result = new Float32Array(data.length);
      for (let i = 0; i < data.length; i += 2) {
        result[i] = (data[i] as number) * (xReversed ? -1 : 1);
        result[i + 1] = (data[i + 1] as number) * (yReversed ? -1 : 1);
      }
      return result;
    });
  };
}

export function directedRange(min: number, max: number, reversed = false) {
  return reversed ? { min: -max, max: -min } : { min, max };
}
