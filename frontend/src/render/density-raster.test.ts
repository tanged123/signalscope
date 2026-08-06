import { describe, expect, it } from "vitest";
import type { EnvelopeBin } from "../generated/protocol";
import { binColumnsFromWire } from "../app/bin-columns";
import {
  DENSITY_ALPHA_FLOOR,
  DENSITY_ALPHA_MAX,
  accumulateEnvelope,
  coverageToImage,
  parseHexColor,
  resolveCoverage,
  type DensityGrid,
} from "./density-raster";

function bin(
  t0: number,
  t1: number,
  min: number,
  max: number,
  hasGap = false,
): EnvelopeBin {
  return {
    t0,
    t1,
    first: min,
    last: max,
    min,
    max,
    sum: min + max,
    sum_sq: min * min + max * max,
    finite_count: "2",
    sample_count: "2",
    has_gap: hasGap,
  };
}

function grid(width: number, height: number): DensityGrid {
  return { coverage: new Float32Array(width * height), width, height };
}

function at(g: DensityGrid, x: number, y: number): number {
  return g.coverage[y * g.width + x] ?? Number.NaN;
}

// Identity-ish transforms: bin midpoints land on columns, values on rows.
const toColumn = (t: number) => t;
const toRow = (v: number) => v;

describe("accumulateEnvelope", () => {
  it("fills the vertical span of an isolated bin", () => {
    const g = grid(8, 8);
    accumulateEnvelope(
      g,
      binColumnsFromWire([bin(1.5, 2.5, 2, 5)]),
      toColumn,
      toRow,
    );
    resolveCoverage(g);
    // Midpoint t=2 -> column 2; rows 2..5 covered once.
    expect(at(g, 2, 1)).toBe(0);
    expect(at(g, 2, 2)).toBe(1);
    expect(at(g, 2, 5)).toBe(1);
    expect(at(g, 2, 6)).toBe(0);
    expect(at(g, 1, 3)).toBe(0);
  });

  it("connects consecutive bins as an interpolated band, not teeth", () => {
    const g = grid(8, 8);
    // Midpoints at columns 1 and 5; min/max ramp 2..4 -> 4..6.
    accumulateEnvelope(
      g,
      binColumnsFromWire([bin(0.5, 1.5, 2, 4), bin(4.5, 5.5, 4, 6)]),
      toColumn,
      toRow,
    );
    resolveCoverage(g);
    // Halfway column 3 covers the lerped band rows 3..5.
    expect(at(g, 3, 2)).toBe(0);
    expect(at(g, 3, 3)).toBe(1);
    expect(at(g, 3, 5)).toBe(1);
    expect(at(g, 3, 6)).toBe(0);
    // No cell counted twice within one series.
    for (const value of g.coverage)
      expect(value === 0 || value === 1).toBe(true);
  });

  it("a gap breaks the band exactly like a pen lift", () => {
    const g = grid(10, 8);
    accumulateEnvelope(
      g,
      binColumnsFromWire([bin(0.5, 1.5, 2, 4), bin(6.5, 7.5, 2, 4, true)]),
      toColumn,
      toRow,
    );
    resolveCoverage(g);
    // Columns strictly between the two midpoints stay empty.
    for (let x = 2; x <= 6; x += 1) {
      for (let y = 0; y < 8; y += 1) expect(at(g, x, y)).toBe(0);
    }
    // The gap bin still draws its own column.
    expect(at(g, 7, 3)).toBe(1);
  });

  it("two series accumulate", () => {
    const g = grid(8, 8);
    const columns = binColumnsFromWire([bin(1.5, 2.5, 2, 5)]);
    accumulateEnvelope(g, columns, toColumn, toRow);
    accumulateEnvelope(g, columns, toColumn, toRow);
    resolveCoverage(g);
    expect(at(g, 2, 3)).toBe(2);
  });

  it("clamps out-of-grid geometry instead of writing out of bounds", () => {
    const g = grid(4, 4);
    accumulateEnvelope(
      g,
      binColumnsFromWire([bin(-10, -9, -5, 20), bin(20, 21, -5, 20)]),
      toColumn,
      toRow,
    );
    resolveCoverage(g);
    expect(g.coverage.some((value) => Number.isNaN(value))).toBe(false);
  });

  it("holds difference marks until resolveCoverage runs", () => {
    const g = grid(8, 8);
    accumulateEnvelope(
      g,
      binColumnsFromWire([bin(1.5, 2.5, 2, 5)]),
      toColumn,
      toRow,
    );
    // Unresolved: +1 at the band top, -1 below the band bottom.
    expect(at(g, 2, 2)).toBe(1);
    expect(at(g, 2, 6)).toBe(-1);
    expect(at(g, 2, 4)).toBe(0);
    resolveCoverage(g);
    expect(at(g, 2, 4)).toBe(1);
    expect(at(g, 2, 6)).toBe(0);
  });
});

describe("coverageToImage", () => {
  it("applies the log-normalized tone map", () => {
    const g = grid(3, 1);
    g.coverage[0] = 1;
    g.coverage[1] = 4;
    g.coverage[2] = 0;
    const pixels = coverageToImage(g, "#ffffff");
    // kMax 4 -> kRef 4; alpha(k) = 0.1 + 0.8 * ln(1 + k) / ln(5).
    const alpha = (k: number) =>
      DENSITY_ALPHA_FLOOR +
      ((DENSITY_ALPHA_MAX - DENSITY_ALPHA_FLOOR) * Math.log(1 + k)) /
        Math.log(5);
    expect(pixels[3]).toBe(Math.round(alpha(1) * 255));
    expect(pixels[7]).toBe(Math.round(alpha(4) * 255));
    expect(pixels[11]).toBe(0);
    expect(pixels[0]).toBe(255);
  });

  it("caps the densest cell at the exposure maximum", () => {
    const g = grid(1, 1);
    g.coverage[0] = 8; // kRef 8: this cell is the reference.
    expect(coverageToImage(g, "#fff")[3]).toBe(
      Math.round(DENSITY_ALPHA_MAX * 255),
    );
  });

  it("keeps lone outliers visible under a dense core", () => {
    const g = grid(2, 1);
    g.coverage[0] = 1;
    g.coverage[1] = 1000; // kRef 1024
    const pixels = coverageToImage(g, "#fff");
    const expected = 0.1 + (0.8 * Math.log(2)) / Math.log(1025); // ≈ 0.180
    expect(pixels[3]).toBe(Math.round(expected * 255));
    expect(pixels[3] as number).toBeGreaterThan(25); // never invisible
  });

  it("an empty grid stays fully transparent", () => {
    expect(coverageToImage(grid(1, 1), "#fff")[3]).toBe(0);
  });
});

describe("parseHexColor", () => {
  it("parses long and short hex, falls back to grey", () => {
    expect(parseHexColor("#4d5563")).toEqual({ r: 0x4d, g: 0x55, b: 0x63 });
    expect(parseHexColor("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHexColor("rgb(1,2,3)")).toEqual({ r: 128, g: 128, b: 128 });
  });
});
