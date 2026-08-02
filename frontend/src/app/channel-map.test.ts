import { describe, expect, it } from "vitest";

import type { SignalSummary } from "../generated/protocol";
import type { ChannelMapEntry } from "../generated/session";
import { Catalog } from "./catalog";
import {
  canonicalFor,
  normalizeChannelName,
  suggestMerges,
} from "./channel-map";

function summary(
  sourceKey: string,
  sourceName: string,
  channel: string,
): SignalSummary {
  return {
    signal_id: `${sourceKey}-${channel}`,
    source_id: sourceKey,
    source_key: sourceKey,
    local_path: channel,
    path: `${sourceName}/${channel}`,
    unit: null,
    point_count: "2",
    t_min: 0,
    t_max: 1,
    last_value: null,
  };
}

describe("channel map", () => {
  it.each([
    ["temperature", "temperature"],
    ["Temp_C", "temp"],
    ["T_amb", "tamb"],
    ["tmp", "tmp"],
  ])("normalizes %s to %s", (name, normalized) => {
    expect(normalizeChannelName(name)).toBe(normalized);
  });

  it("suggests near-matches across sources and chooses the common canonical", () => {
    const catalog = Catalog.build([
      summary("s1", "run_01", "temp"),
      summary("s2", "run_02", "Temp_C"),
      summary("s3", "run_03", "temp"),
      summary("s1", "run_01", "speed"),
      summary("s2", "run_02", "speed"),
    ]);

    expect(suggestMerges(catalog, [])).toEqual([
      {
        names: [
          { sourceKey: "s1", sourceName: "run_01", channel: "temp" },
          { sourceKey: "s2", sourceName: "run_02", channel: "Temp_C" },
          {
            sourceKey: "s3",
            sourceName: "run_03",
            channel: "temp",
          },
        ],
        canonical: "temp",
      },
    ]);
  });

  it("skips channels covered by map entries and identity dismissals", () => {
    const catalog = Catalog.build([
      summary("s1", "run_01", "temp"),
      summary("s2", "run_02", "Temp_C"),
      summary("s3", "run_03", "temp"),
    ]);
    const map: ChannelMapEntry[] = [
      {
        canonical: "temp",
        aliases: [{ source_key: "s1", name: "temp" }],
      },
      {
        canonical: "Temp_C",
        aliases: [{ source_key: "s2", name: "Temp_C" }],
      },
      {
        canonical: "temperature",
        aliases: [{ source_key: "s3", name: "temp" }],
      },
    ];

    expect(suggestMerges(catalog, map)).toEqual([]);
  });

  it("never suggests a merge within one source", () => {
    const catalog = Catalog.build([
      summary("s1", "run_01", "temp"),
      summary("s1", "run_01", "Temp_C"),
    ]);

    expect(suggestMerges(catalog, [])).toEqual([]);
  });

  it("resolves mapped and unmapped names", () => {
    const map: ChannelMapEntry[] = [
      {
        canonical: "temp",
        aliases: [{ source_key: "s7", name: "temperature" }],
      },
    ];

    expect(canonicalFor(map, "s7", "temperature")).toBe("temp");
    expect(canonicalFor(map, "s8", "temperature")).toBe("temperature");
  });
});
