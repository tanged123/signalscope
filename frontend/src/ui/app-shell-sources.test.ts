// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import type { SourceSummary } from "../generated/protocol";
import { renderSourceRows } from "./app-shell";

function source(index: number): SourceSummary {
  return {
    source_id: String(index),
    source_key: `source-${String(index)}`,
    path: `/data/run_${String(index)}.csv`,
    prefix: `run_${String(index)}`,
    point_count: "1000",
    time_domain: {
      unit: "seconds",
      origin: "relative",
      alignment_origin: 0,
    },
    scale: 1,
    offset: 0,
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

  it("keeps alignment controls in an on-demand popover", () => {
    const element = document.createElement("div");
    const onAlignment = vi.fn();
    renderSourceRows(
      element,
      [source(1), source(2)],
      false,
      () => undefined,
      onAlignment,
    );

    expect(element.querySelectorAll("input, select")).toHaveLength(0);
    const first = element.querySelector<HTMLButtonElement>(".source-align");
    expect(first?.textContent).toBe("align ▾");
    first?.click();
    expect(element.querySelectorAll(".source-alignment-popover")).toHaveLength(
      1,
    );
    expect(
      element.querySelector<HTMLInputElement>(".source-time-scale")?.value,
    ).toBe("1");
    expect(
      element.querySelector<HTMLInputElement>(".source-time-offset")?.value,
    ).toBe("0");

    const unit = element.querySelector<HTMLSelectElement>(".source-time-unit");
    const scale = element.querySelector<HTMLInputElement>(".source-time-scale");
    const offset = element.querySelector<HTMLInputElement>(
      ".source-time-offset",
    );
    if (unit === null || scale === null || offset === null) {
      throw new Error("alignment controls missing");
    }
    unit.value = "milliseconds";
    scale.value = "2";
    offset.value = "3";
    element
      .querySelector<HTMLButtonElement>(".source-alignment-apply")
      ?.click();
    expect(onAlignment).toHaveBeenCalledWith(
      expect.objectContaining({ source_key: "source-1" }),
      expect.objectContaining({ unit: "milliseconds" }),
      2,
      3,
    );

    element.querySelector<HTMLButtonElement>(".source-align")?.click();
    element.querySelectorAll<HTMLButtonElement>(".source-align")[1]?.click();
    expect(element.querySelectorAll(".source-alignment-popover")).toHaveLength(
      1,
    );
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(element.querySelector(".source-alignment-popover")).toBeNull();
  });

  it("marks sources whose alignment differs from identity", () => {
    const element = document.createElement("div");
    const aligned = source(1);
    aligned.offset = 4;
    renderSourceRows(element, [aligned], false, () => undefined);
    expect(element.querySelector(".source-alignment-marker")?.textContent).toBe(
      "≠",
    );
  });
});
