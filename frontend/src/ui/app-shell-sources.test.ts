// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import type { SourceSummary } from "../generated/protocol";
import { renderSourceRows } from "./app-shell";

function source(index: number): SourceSummary {
  return {
    source_id: String(index),
    source_key: `source-${String(index)}`,
    path: `/data/run_${String(index)}.csv`,
    prefix: `run_${String(index)}`,
    point_count: "1000",
  };
}

describe("renderSourceRows", () => {
  it("keeps small source lists expanded without a toggle", () => {
    const element = document.createElement("div");
    renderSourceRows(
      element,
      [source(1), source(2), source(3)],
      false,
      () => undefined,
    );
    expect(element.querySelectorAll(".source-row")).toHaveLength(3);
    expect(element.querySelector(".source-summary")).toBeNull();
  });

  it("summarizes large lists and virtualizes the expanded rows", () => {
    const element = document.createElement("div");
    const sources = Array.from({ length: 200 }, (_, index) => source(index));
    renderSourceRows(element, sources, false, () => undefined);
    expect(element.textContent).toContain("200 sources · 200,000 pts");
    expect(element.querySelectorAll(".source-row")).toHaveLength(0);

    renderSourceRows(element, sources, true, () => undefined);
    expect(element.querySelectorAll(".source-row").length).toBeLessThan(200);
  });
});
