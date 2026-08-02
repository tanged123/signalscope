// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { Catalog } from "../app/catalog";
import type { MergeSuggestion } from "../app/channel-map";
import type { SignalSummary } from "../generated/protocol";
import type { ChannelMapEntry } from "../generated/session";
import { ChannelMapView } from "./channel-map-view";

function signal(
  sourceKey: string,
  channel: string,
  unit: string | null = null,
): SignalSummary {
  return {
    signal_id: `${sourceKey}-${channel}`,
    source_id: sourceKey,
    source_key: sourceKey,
    local_path: channel,
    path: `${sourceKey}/${channel}`,
    unit,
    point_count: "1",
    t_min: 0,
    t_max: 1,
    last_value: 1,
  };
}

describe("ChannelMapView", () => {
  it("renders merged, consistent, and pending sections with bounded rows", () => {
    const host = document.createElement("div");
    const onUnmerge = vi.fn();
    const onMerge = vi.fn();
    const onKeep = vi.fn();
    const view = new ChannelMapView(host, {
      onClose: vi.fn(),
      onUnmerge,
      onMerge,
      onKeep,
    });
    const aliases: ChannelMapEntry = {
      canonical: "temp",
      aliases: [
        { source_key: "run-01", name: "temp" },
        { source_key: "run-02", name: "Temp_C" },
      ],
    };
    const catalog = Catalog.build(
      [signal("run-01", "temp", "K"), signal("run-02", "Temp_C", "C")],
      [aliases],
    );
    const suggestion: MergeSuggestion = {
      canonical: "speed",
      names: [
        { sourceKey: "run-01", sourceName: "run-01", channel: "speed" },
        { sourceKey: "run-02", sourceName: "run-02", channel: "speed_ms" },
      ],
    };
    view.open(
      catalog,
      [aliases, { canonical: "steady", aliases: [] }],
      [suggestion],
    );

    expect(host.querySelector('[data-section="merged"]')).not.toBeNull();
    expect(host.querySelector('[data-section="consistent"]')).not.toBeNull();
    expect(host.querySelector('[data-section="pending"]')).not.toBeNull();
    expect(host.querySelector(".unit-conflict-marker")?.textContent).toBe(
      "unit?",
    );
    expect(host.querySelectorAll(".channel-map-consistent-row")).toHaveLength(
      0,
    );
    host
      .querySelector<HTMLButtonElement>(".channel-map-consistent-summary")
      ?.click();
    expect(
      host.querySelectorAll(".channel-map-consistent-row").length,
    ).toBeLessThanOrEqual(30);
    host.querySelector<HTMLButtonElement>('[data-action="unmerge"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-action="merge"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-action="keep"]')?.click();

    expect(onUnmerge).toHaveBeenCalledWith("temp");
    expect(onMerge).toHaveBeenCalledWith(suggestion);
    expect(onKeep).toHaveBeenCalledWith(suggestion);
  });
});
