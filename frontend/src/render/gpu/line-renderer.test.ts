import { describe, expect, it, vi } from "vitest";
import { GpuLineRenderer } from "./line-renderer";

function runtime() {
  return {
    format: "bgra8unorm",
    shader: vi.fn(() => ({})),
    renderPipeline: vi.fn((_key: string, create: () => GPURenderPipeline) =>
      create(),
    ),
  } as never;
}

function tile(page: number, key: string) {
  return {
    key,
    points: { page, offset: 0, size: 256 },
    pointCount: 2,
    origin: 0,
    seriesSlot: page,
    sourceStart: String(page),
    sourceEnd: String(page + 2),
    coarse: false,
  };
}

describe("GpuLineRenderer", () => {
  it("separates transform, style, and residency dirtiness", () => {
    const renderer = new GpuLineRenderer(runtime(), undefined, "panel");
    renderer.setTiles([tile(0, "a")]);
    expect(renderer.sceneDirty).toBe(true);
    renderer.encode({} as GPUCommandEncoder);
    expect(renderer.sceneDirty).toBe(false);
    renderer.setViewport({
      xMin: 0,
      xMax: 1,
      yMin: 0,
      yMax: 1,
      plotX: 0,
      plotY: 0,
      plotWidth: 100,
      plotHeight: 100,
      devicePixelRatio: 1,
    });
    expect(renderer.transformDirty).toBe(true);
    expect(renderer.residencyDirty).toBe(false);
    renderer.setStyles([]);
    expect(renderer.styleDirty).toBe(true);
  });

  it("counts one indirect draw per resident page", () => {
    const renderer = new GpuLineRenderer(runtime(), undefined, "panel");
    renderer.setTiles([tile(0, "a"), tile(0, "b"), tile(1, "c")]);
    renderer.encode({} as GPUCommandEncoder);
    expect(renderer.metrics().pages).toBe(2);
    expect(renderer.metrics().drawCalls).toBe(2);
  });

  it("reports compacted GPU candidates separately from source segments", () => {
    const renderer = new GpuLineRenderer(runtime(), undefined, "panel");
    renderer.setTiles([tile(0, "a"), tile(0, "b")]);
    renderer.encode({} as GPUCommandEncoder);
    expect(renderer.metrics().descriptors).toBe(2);
  });
});
