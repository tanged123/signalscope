import { describe, expect, it } from "vitest";
import type { EnvelopeBin } from "../generated/protocol";
import { binColumnsFromWire } from "../app/bin-columns";
import {
  accumulateEnvelope,
  coverageToImage,
  parseHexColor,
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
    expect(g.coverage.some((value) => Number.isNaN(value))).toBe(false);
  });
});

describe("coverageToImage", () => {
  it("applies the physical compositing law", () => {
    const g = grid(2, 1);
    g.coverage[0] = 1;
    g.coverage[1] = 2;
    const pixels = coverageToImage(g, "#ffffff", 0.5);
    // k=1 -> alpha 0.5; k=2 -> 1 - 0.25 = 0.75.
    expect(pixels[3]).toBe(Math.round(0.5 * 255));
    expect(pixels[7]).toBe(Math.round(0.75 * 255));
    expect(pixels[0]).toBe(255);
  });

  it("zero coverage stays fully transparent", () => {
    const pixels = coverageToImage(grid(1, 1), "#ffffff", 0.5);
    expect(pixels[3]).toBe(0);
  });
});

describe("parseHexColor", () => {
  it("parses long and short hex, falls back to grey", () => {
    expect(parseHexColor("#4d5563")).toEqual({ r: 0x4d, g: 0x55, b: 0x63 });
    expect(parseHexColor("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHexColor("rgb(1,2,3)")).toEqual({ r: 128, g: 128, b: 128 });
  });
});
