/**
 * Total envelope bins a panel may request per tile query (ADR 0036). Split
 * across series by the host with a 64-bin floor; the density policy
 * (render/density-policy.ts) derives the stroke-vs-raster switch from the
 * same number so the two can never disagree.
 */
export const TILE_BIN_BUDGET = 250_000;
