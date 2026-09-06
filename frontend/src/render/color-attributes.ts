import { colorFraction, viridis, type ColorScale } from "../app/color-scale";
import { createFeedCache } from "./line2d-adapter";

const cache = createFeedCache<Float64Array, ColorScale["range"], Float32Array>(
  (a, b) => a?.[0] === b?.[0] && a?.[1] === b?.[1],
);

export function colorAttributes(
  values: Float64Array,
  scale: ColorScale,
): Float32Array {
  return cache(values, scale.range, () => {
    const result = new Float32Array(values.length * 4);
    for (let i = 0; i < values.length; i += 1) {
      const value = values[i] as number;
      if (!Number.isFinite(value) || scale.range === null)
        result[i * 4 + 3] = -1;
      else result.set(viridis(colorFraction(value, scale.range)), i * 4);
    }
    return result;
  });
}
