import { colorFraction, type ColorScale } from "../app/color-scale";
import {
  DEFAULT_CONTOUR,
  sampleContour,
  type CompiledContour,
} from "../app/palettes";
import { createFeedCache } from "./line2d-adapter";

const cache = createFeedCache<
  Float64Array,
  {
    range: ColorScale["range"];
    scale: ColorScale["scale"];
    contour: CompiledContour;
  },
  Float32Array
>(
  (a, b) =>
    a.range?.[0] === b.range?.[0] &&
    a.range?.[1] === b.range?.[1] &&
    a.scale === b.scale &&
    a.contour === b.contour,
);

export function colorAttributes(
  values: Float64Array,
  scale: ColorScale,
  contour = DEFAULT_CONTOUR,
): Float32Array {
  return cache(
    values,
    { range: scale.range, scale: scale.scale, contour },
    () => {
      const result = new Float32Array(values.length * 4);
      for (let i = 0; i < values.length; i += 1) {
        const value = values[i] as number;
        if (
          !Number.isFinite(value) ||
          scale.range === null ||
          (scale.scale === "log" && value <= 0)
        )
          result[i * 4 + 3] = -1;
        else
          result.set(
            sampleContour(
              contour,
              colorFraction(value, scale.range, scale.scale),
            ),
            i * 4,
          );
      }
      return result;
    },
  );
}
