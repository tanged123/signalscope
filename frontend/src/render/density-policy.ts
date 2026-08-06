import { TILE_BIN_BUDGET } from "../app/budgets";

/**
 * Stroke-vs-raster decision for envelope panels (spec §"Density policy").
 *
 * The tile host splits TILE_BIN_BUDGET across series with a 64-bin floor
 * (shell/src-tauri/src/lib.rs and app/data-plane.ts), so the per-series
 * allocation is what the renderer will actually receive. Below one bin per
 * two device pixels the envelope teeth separate into a comb; at that point
 * per-series strokes stop being a faithful representation and the panel
 * switches to the aggregate coverage raster. Inputs move stepwise (series
 * membership, resize) — never per frame — so the switch cannot flicker
 * during interaction.
 */
export function densityMode(
  seriesCount: number,
  plotWidthDevice: number,
): "strokes" | "raster" {
  if (seriesCount <= 0 || plotWidthDevice <= 0) return "strokes";
  const allocation = Math.max(64, Math.floor(TILE_BIN_BUDGET / seriesCount));
  return allocation >= plotWidthDevice / 2 ? "strokes" : "raster";
}
