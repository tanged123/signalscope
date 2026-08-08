import { describe, expect, it, vi } from "vitest";
import {
  GpuLineRenderer,
  plotScissor,
  PREMULTIPLIED_ALPHA_BLEND,
} from "./line-renderer";

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

  it("clamps the same device-pixel plot scissor for both render passes", () => {
    expect(
      plotScissor(
        { plotX: -4, plotY: 8, plotWidth: 120.4, plotHeight: 80.2 },
        100,
        60,
      ),
    ).toEqual({ x: 0, y: 8, width: 100, height: 52 });
    expect(PREMULTIPLIED_ALPHA_BLEND).toEqual({
      color: {
        srcFactor: "one",
        dstFactor: "one-minus-src-alpha",
        operation: "add",
      },
      alpha: {
        srcFactor: "one",
        dstFactor: "one-minus-src-alpha",
        operation: "add",
      },
    });
  });
});
