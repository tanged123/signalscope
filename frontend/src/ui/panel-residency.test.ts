import { describe, expect, it } from "vitest";
import { panelsToEvict, type ResidentPanel } from "./panel-residency";

describe("panelsToEvict", () => {
  it("keeps three resident thousand-series panels", () => {
    expect(
      panelsToEvict(
        [
          { id: "a", seriesCount: 1000, lastUsed: 1, active: false },
          { id: "b", seriesCount: 1000, lastUsed: 2, active: false },
          { id: "c", seriesCount: 1000, lastUsed: 3, active: true },
        ],
        3000,
      ),
    ).toEqual([]);
  });

  it("evicts least-recent inactive panels and never the active panel", () => {
    const panels: ResidentPanel[] = [
      { id: "old", seriesCount: 1000, lastUsed: 1, active: false },
      { id: "new", seriesCount: 1000, lastUsed: 3, active: false },
      { id: "active", seriesCount: 2000, lastUsed: 4, active: true },
    ];
    expect(panelsToEvict(panels, 3000)).toEqual(["old"]);
  });
});
