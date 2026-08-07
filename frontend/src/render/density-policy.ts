export const FRAME_BIN_BUDGET = 250_000;
export const MIN_BINS_PER_SERIES = 64;

/**
 * Stroke-vs-raster decision for envelope panels (spec §"Density policy").
 *
 * Below one bin per two device pixels the envelope teeth separate into a comb;
 * at that point per-series strokes stop being a faithful representation and
 * the panel switches to the aggregate coverage raster.
 */
export function densityMode(
  seriesCount: number,
  plotWidthDevice: number,
): "strokes" | "raster" {
  if (seriesCount <= 0 || plotWidthDevice <= 0) return "strokes";
  const allocation = Math.max(
    MIN_BINS_PER_SERIES,
    Math.floor(FRAME_BIN_BUDGET / seriesCount),
  );
  return allocation >= plotWidthDevice / 2 ? "strokes" : "raster";
}
