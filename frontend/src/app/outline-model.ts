import type { SeriesRef } from "../generated/session";
import type { Catalog, CatalogSeries } from "./catalog";
import { evaluateSelector } from "./selector";

export interface OutlineSeriesRow {
  kind: "series";
  key: string;
  ref: SeriesRef;
  path: string;
  depth: 0 | 1;
  channel: string;
  source: string;
}

export interface OutlineGroupRow {
  kind: "group";
  key: string;
  label: string;
  expanded: boolean;
  refs: readonly SeriesRef[];
  childKeys: readonly string[];
  paths: readonly string[];
  aggregate: string;
}

export type OutlineRow = OutlineGroupRow | OutlineSeriesRow;

export interface OutlineOptions {
  filter: string;
  expanded: ReadonlySet<string>;
}

export function filterCatalogSeries(
  catalog: Catalog,
  filter: string,
): CatalogSeries[] {
  const input = filter.trim();
  const query = input.toLowerCase();
  const evaluation = input === "" ? null : evaluateSelector(catalog, input);
  const selectorSyntax = /[*?|[@:]/.test(input);
  const selectorRefs =
    evaluation !== null && (evaluation.signalCount > 0 || selectorSyntax)
      ? new Set(
          evaluation.series.map((series) =>
            catalog.refKey({
              source_key: series.sourceKey,
              channel: series.channel,
            }),
          ),
        )
      : null;
  return catalog.allSeries().filter(
    (series) =>
      query === "" ||
      (selectorRefs !== null
        ? selectorRefs.has(
            catalog.refKey({
              source_key: series.sourceKey,
              channel: series.channel,
            }),
          )
        : series.channel.toLowerCase().includes(query) ||
          series.path.toLowerCase().includes(query)),
  );
}

export interface VirtualSlice {
  start: number;
  end: number;
  topPadding: number;
  totalHeight: number;
}

export function virtualSlice(
  count: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan = 8,
): VirtualSlice {
  const totalHeight = count * rowHeight;
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(
    count,
    Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan,
  );
  return {
    start: first,
    end: last,
    topPadding: first * rowHeight,
    totalHeight,
  };
}

export function buildOutlineRows(
  catalog: Catalog,
  options: OutlineOptions,
): OutlineRow[] {
  const groups = new Map<string, CatalogSeries[]>();
  for (const series of filterCatalogSeries(catalog, options.filter)) {
    const members = groups.get(series.channel) ?? [];
    members.push(series);
    groups.set(series.channel, members);
  }

  const rows: OutlineRow[] = [];
  for (const [channel, members] of groups) {
    if (members.length === 1) {
      rows.push(seriesRow(catalog, members[0] as CatalogSeries, 0));
      continue;
    }
    const refs = members.map(refForSeries);
    const key = `group:channel:${channel}`;
    const expanded = options.filter.trim() !== "" || options.expanded.has(key);
    rows.push({
      kind: "group",
      key,
      label: channel,
      expanded,
      refs,
      childKeys: refs.map((ref) => catalog.refKey(ref)),
      paths: members.map((series) => series.path),
      aggregate: `${String(new Set(refs.map((ref) => ref.source_key)).size)} srcs`,
    });
    if (expanded) {
      rows.push(...members.map((series) => seriesRow(catalog, series, 1)));
    }
  }
  return rows;
}

function seriesRow(
  catalog: Catalog,
  series: CatalogSeries,
  depth: 0 | 1,
): OutlineSeriesRow {
  const ref = refForSeries(series);
  return {
    kind: "series",
    key: catalog.refKey(ref),
    ref,
    path: series.path,
    depth,
    channel: series.channel,
    source: series.sourceName,
  };
}

function refForSeries(series: CatalogSeries): SeriesRef {
  return { source_key: series.sourceKey, channel: series.channel };
}
