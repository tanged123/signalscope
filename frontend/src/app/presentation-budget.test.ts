import { describe, expect, it } from "vitest";

import {
  autoPresentationBudgets,
  CPU_BYTES_PER_LINE2D_VALUE,
  GPU_BYTES_PER_LINE2D_VALUE,
  MIB,
  planPresentationDensity,
  type PanelDemand,
} from "./presentation-budget";

const demand = (overrides: Partial<PanelDemand> = {}): PanelDemand => ({
  panelId: "panel-1",
  physicalPixels: 1000,
  paddingRatio: 2,
  visibleSeries: 1,
  reductionExpansion: 1,
  ...overrides,
});

describe("autoPresentationBudgets", () => {
  it("derives and clamps independent CPU and GPU ceilings", () => {
    expect(autoPresentationBudgets(256 * MIB, 8)).toEqual({
      cpuBytes: 1024 * MIB,
      gpuBytes: 512 * MIB,
    });
    expect(autoPresentationBudgets(64 * MIB, 1)).toEqual({
      cpuBytes: 512 * MIB,
      gpuBytes: 256 * MIB,
    });
    expect(autoPresentationBudgets(2 * 1024 * MIB, 32)).toEqual({
      cpuBytes: 2 * 1024 * MIB,
      gpuBytes: 1024 * MIB,
    });
    expect(autoPresentationBudgets(256 * MIB)).toEqual({
      cpuBytes: 512 * MIB,
      gpuBytes: 512 * MIB,
    });
  });
});

describe("planPresentationDensity", () => {
  it("admits 5,000 series with one constrained uniform density", () => {
    const plan = planPresentationDensity({
      demands: [demand({ visibleSeries: 5000 })],
      budgets: { cpuBytes: 512 * MIB, gpuBytes: 256 * MIB },
      retainedCpuBytes: 0,
      retainedGpuBytes: 0,
    });

    expect(plan.fits).toBe(true);
    expect(plan.limited).toBe(true);
    expect(plan.density).toBeGreaterThan(0);
    expect(plan.density).toBeLessThan(2);
    expect(plan.requests.get("panel-1")).toBeGreaterThanOrEqual(1);
  });

  it("uses one density for panels with unequal physical widths", () => {
    const plan = planPresentationDensity({
      demands: [
        demand({ panelId: "narrow", physicalPixels: 400 }),
        demand({ panelId: "wide", physicalPixels: 1600 }),
      ],
      budgets: { cpuBytes: 8 * MIB, gpuBytes: 8 * MIB },
      retainedCpuBytes: 0,
      retainedGpuBytes: 0,
    });

    expect(plan.fits).toBe(true);
    expect(plan.density).toBe(2);
    expect(plan.requests.get("narrow")).toBe(800);
    expect(plan.requests.get("wide")).toBe(3200);
  });

  it("does not charge an empty layout for demand", () => {
    expect(
      planPresentationDensity({
        demands: [],
        budgets: { cpuBytes: 1, gpuBytes: 1 },
        retainedCpuBytes: 0,
        retainedGpuBytes: 0,
      }),
    ).toMatchObject({
      density: 2,
      fits: true,
      limited: false,
      estimatedCpuBytes: 0,
      estimatedGpuBytes: 0,
    });
  });

  it("lowers density when retained presentation bytes consume headroom", () => {
    const input = {
      demands: [demand({ visibleSeries: 100 })],
      budgets: { cpuBytes: 256 * MIB, gpuBytes: 256 * MIB },
      retainedCpuBytes: 0,
      retainedGpuBytes: 0,
    };
    const unretained = planPresentationDensity(input);
    const retained = planPresentationDensity({
      ...input,
      retainedCpuBytes: 240 * MIB,
      retainedGpuBytes: 240 * MIB,
    });

    expect(unretained.density).toBe(2);
    expect(retained.density).toBeLessThan(unretained.density);
    expect(retained.fits).toBe(true);
  });

  it("charges family-specific worst-case reducer expansion", () => {
    const base = {
      budgets: { cpuBytes: 512 * MIB, gpuBytes: 256 * MIB },
      retainedCpuBytes: 0,
      retainedGpuBytes: 0,
    };
    const ordinary = planPresentationDensity({
      ...base,
      demands: [demand({ visibleSeries: 12 })],
    });
    const paired = planPresentationDensity({
      ...base,
      demands: [demand({ visibleSeries: 12, reductionExpansion: 24 })],
    });

    expect(paired.estimatedCpuBytes).toBe(ordinary.estimatedCpuBytes * 24);
    expect(paired.estimatedGpuBytes).toBe(ordinary.estimatedGpuBytes * 24);
  });

  it("charges Line2D units with their column widths", () => {
    const plan = planPresentationDensity({
      demands: [
        demand({
          cpuBytesPerUnit: CPU_BYTES_PER_LINE2D_VALUE,
          gpuBytesPerUnit: GPU_BYTES_PER_LINE2D_VALUE,
        }),
      ],
      budgets: { cpuBytes: 512 * MIB, gpuBytes: 256 * MIB },
      retainedCpuBytes: 0,
      retainedGpuBytes: 0,
    });

    expect(plan.estimatedCpuBytes).toBe(32_000);
    expect(plan.estimatedGpuBytes).toBe(16_000);
  });

  it("reports an impossible one-pixel minimum instead of rejecting unevenly", () => {
    const plan = planPresentationDensity({
      demands: [demand({ physicalPixels: 1, visibleSeries: 5000 })],
      budgets: { cpuBytes: 1, gpuBytes: 1 },
      retainedCpuBytes: 0,
      retainedGpuBytes: 0,
    });

    expect(plan.fits).toBe(false);
    expect(plan.density).toBeGreaterThan(0);
    expect(plan.requests.get("panel-1")).toBe(1);
  });
});
