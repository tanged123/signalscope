import type { ColorScale } from "../app/color-scale";
import type { Range } from "../app/plot-math";
import type { Palette, SeriesStroke } from "./plot-theme";

/**
 * SignalScope's renderer-owned input for one Cartesian line plot.
 *
 * The immutable data buffer is already in ChartGPU's interleaved `[x, y]`
 * layout. Its object identity is the publication identity.
 */
interface Line2DSeriesInput {
  id: string;
  name: string;
  data: Float32Array;
  pointColors?: Float32Array | undefined;
  style: SeriesStroke;
}

interface Line2DAxisInput {
  label: string;
}

export interface Line2DRenderInput {
  colorScale?: ColorScale | undefined;
  xOrigin: number;
  series: readonly Line2DSeriesInput[];
  xRange: Range;
  yRange: readonly [number, number];
  axes: {
    x: Line2DAxisInput;
    y: Line2DAxisInput;
    style: "gutter" | "inline";
  };
}

/** Presentation-only additions shared by the current panel shell. */
export interface Line2DRenderRequest extends Line2DRenderInput {
  emphasisIndices: readonly number[];
  palette: Palette;
}
