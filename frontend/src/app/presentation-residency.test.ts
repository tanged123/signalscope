import { describe, expect, it } from "vitest";
import {
  planPresentationEvictions,
  type ResidentBank,
} from "./presentation-residency";

describe("planPresentationEvictions", () => {
  it("evicts over-budget banks in the prescribed order", () => {
    const banks: ResidentBank[] = [
      bank("inactive-detail-old", "detail", 1, 50, 50, false),
      bank("inactive-detail-new", "detail", 2, 50, 50, false),
      bank("inactive-overview", "overview", 3, 50, 50, false),
      bank("active-superseded", "detail", 4, 50, 0, true, true),
      bank("inactive-cpu-detail", "detail", 5, 50, 0, false),
      bank("inactive-cpu-overview", "overview", 6, 50, 0, false),
      bank("active-selected", "detail", 7, 100, 100, true, false, true),
      bank("active-overview", "overview", 8, 100, 100, true),
    ];

    expect(
      planPresentationEvictions({
        cpuBytes: 400,
        gpuBytes: 400,
        budgets: { cpuBytes: 100, gpuBytes: 100 },
        banks,
        activePanelIds: new Set([
          "active-superseded",
          "active-selected",
          "active-overview",
        ]),
      }),
    ).toEqual([
      { panelId: "inactive-detail-old", role: "detail", medium: "gpu" },
      { panelId: "inactive-detail-new", role: "detail", medium: "gpu" },
      { panelId: "inactive-overview", role: "overview", medium: "gpu" },
      { panelId: "active-superseded", role: "detail", medium: "cpu" },
      { panelId: "inactive-detail-old", role: "detail", medium: "cpu" },
      { panelId: "inactive-detail-new", role: "detail", medium: "cpu" },
      { panelId: "inactive-cpu-detail", role: "detail", medium: "cpu" },
      { panelId: "inactive-overview", role: "overview", medium: "cpu" },
      { panelId: "inactive-cpu-overview", role: "overview", medium: "cpu" },
    ]);
  });

  it("protects the active overview and selected bank", () => {
    const banks: ResidentBank[] = [
      bank("active-overview", "overview", 1, 100, 100, true),
      bank("active-selected", "detail", 2, 100, 100, true, false, true),
    ];

    expect(
      planPresentationEvictions({
        cpuBytes: 300,
        gpuBytes: 300,
        budgets: { cpuBytes: 1, gpuBytes: 1 },
        banks,
        activePanelIds: new Set(["active-overview", "active-selected"]),
      }),
    ).toEqual([]);
  });
});

function bank(
  panelId: string,
  role: ResidentBank["role"],
  lastUsed: number,
  cpuBytes: number,
  gpuBytes: number,
  active: boolean,
  superseded = false,
  selected = false,
): ResidentBank {
  return {
    panelId,
    role,
    lastUsed,
    cpuBytes,
    gpuBytes,
    active,
    superseded,
    selected,
  };
}
