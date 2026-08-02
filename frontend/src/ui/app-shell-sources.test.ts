// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import type { SourceSummary } from "../generated/protocol";
import {
  openSourceAlignment,
  renderDockFooter,
  shellMarkup,
  statusAggregate,
} from "./app-shell";

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

describe("source dock rail", () => {
  it("formats the status identity as one aggregate readout", () => {
    expect(statusAggregate(2, 17, 2_000)).toBe(
      "2 sources · 17 signals · 2,000 pts",
    );
  });

  it("does not render a duplicate per-source listing", () => {
    const markup = shellMarkup();
    expect(markup).not.toContain('class="source-rows"');
    expect(markup).toContain('class="ingest-progress"');
    expect(markup).toContain('class="channel-suggestions"');
  });

  it("keeps source alignment in the shared on-demand popover", () => {
    const container = document.createElement("div");
    const row = document.createElement("div");
    const anchor = document.createElement("button");
    row.append(anchor);
    container.append(row);
    const onAlignment = vi.fn();
    openSourceAlignment(container, row, anchor, source(1), onAlignment);

    expect(container.querySelectorAll("input, select")).toHaveLength(3);
    const unit =
      container.querySelector<HTMLSelectElement>(".source-time-unit");
    const scale =
      container.querySelector<HTMLInputElement>(".source-time-scale");
    const offset = container.querySelector<HTMLInputElement>(
      ".source-time-offset",
    );
    if (unit === null || scale === null || offset === null)
      throw new Error("alignment controls missing");
    unit.value = "milliseconds";
    scale.value = "2";
    offset.value = "3";
    container
      .querySelector<HTMLButtonElement>(".source-alignment-apply")
      ?.click();
    expect(onAlignment).toHaveBeenCalledWith(
      expect.objectContaining({ source_key: "source-1" }),
      expect.objectContaining({ unit: "milliseconds" }),
      2,
      3,
    );

    openSourceAlignment(container, row, anchor, source(1), onAlignment);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(container.querySelector(".source-alignment-popover")).toBeNull();
  });
});

describe("renderDockFooter", () => {
  it("shows aggregate counts, loaded formats, and a load action", () => {
    const element = document.createElement("div");
    const onAddSource = vi.fn();
    renderDockFooter(
      element,
      [source(1), { ...source(2), path: "/data/run_2.mcap" }],
      17,
      onAddSource,
    );

    expect(element.querySelector(".dock-aggregate")?.textContent).toContain(
      "2 sources · 17 signals",
    );
    expect(element.querySelector(".dock-points")?.textContent).toBe(
      "2,000 pts",
    );
    expect(element.querySelector(".dock-formats")?.textContent).toBe(
      "CSV · MCAP",
    );
    element.querySelector<HTMLButtonElement>(".dock-add-source")?.click();
    expect(onAddSource).toHaveBeenCalledTimes(1);
  });

  it("shows the supported-format hint only for an empty workspace", () => {
    const element = document.createElement("div");
    renderDockFooter(element, [], 0, vi.fn());
    expect(element.querySelector(".dock-formats")?.textContent).toBe(
      "CSV · MCAP",
    );
    expect(element.querySelector(".dock-add-source")?.textContent).toBe(
      "+ source",
    );
  });
});

it("keeps the filter prefix outside the input", () => {
  const markup = shellMarkup();
  expect(markup).toContain('class="search-filter-row"');
  expect(markup).toContain('<span class="search-filter-prefix">/</span>');
  expect(markup).toContain('class="dock-add-source"');
});
