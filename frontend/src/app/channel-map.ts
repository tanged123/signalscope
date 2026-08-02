import type { ChannelMapEntry } from "../generated/session";
import type { Catalog } from "./catalog";

export interface MergeSuggestion {
  names: readonly {
    sourceKey: string;
    sourceName: string;
    channel: string;
  }[];
  canonical: string;
}

const UNIT_SUFFIXES = new Set([
  "c",
  "k",
  "f",
  "degc",
  "degk",
  "degf",
  "ms",
  "s",
  "v",
  "mv",
  "a",
  "ma",
  "pa",
  "kpa",
  "bar",
  "pct",
  "percent",
]);

export function normalizeChannelName(name: string): string {
  const lower = name.trim().toLowerCase();
  const suffix = lower.match(/^(.*)_([a-z]+)$/);
  const withoutUnit =
    suffix !== null && UNIT_SUFFIXES.has(suffix[2] ?? "")
      ? (suffix[1] ?? "")
      : lower;
  return withoutUnit.replace(/[_\-\s]/g, "");
}

export function canonicalFor(
  map: readonly ChannelMapEntry[],
  sourceKey: string,
  name: string,
): string {
  for (const entry of map) {
    if (
      entry.aliases.some(
        (alias) => alias.source_key === sourceKey && alias.name === name,
      )
    ) {
      return entry.canonical;
    }
  }
  return name;
}

export function suggestMerges(
  catalog: Catalog,
  map: readonly ChannelMapEntry[],
): MergeSuggestion[] {
  const groups = new Map<
    string,
    {
      sourceKey: string;
      sourceName: string;
      channel: string;
    }[]
  >();

  for (const series of catalog.allSeries()) {
    const channel = series.sourceChannel;
    if (isCovered(map, series.sourceKey, channel)) continue;
    const key = normalizeChannelName(channel);
    const group = groups.get(key) ?? [];
    group.push({
      sourceKey: series.sourceKey,
      sourceName: series.sourceName,
      channel,
    });
    groups.set(key, group);
  }

  return [...groups.values()]
    .filter((names) => {
      const channels = new Set(names.map((entry) => entry.channel));
      const sources = new Set(names.map((entry) => entry.sourceKey));
      return channels.size >= 2 && sources.size >= 2;
    })
    .map((names) => ({
      names,
      canonical: mostCommonName(names.map((entry) => entry.channel)),
    }))
    .sort((left, right) => left.canonical.localeCompare(right.canonical));
}

function isCovered(
  map: readonly ChannelMapEntry[],
  sourceKey: string,
  name: string,
): boolean {
  return map.some((entry) =>
    entry.aliases.some(
      (alias) => alias.source_key === sourceKey && alias.name === name,
    ),
  );
}

function mostCommonName(names: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return (
    [...counts.entries()].sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    )[0]?.[0] ?? ""
  );
}
