import type { SeriesRef } from "../generated/session";
import type { Catalog, CatalogSeries } from "./catalog";
import { evaluateSelector } from "./selector";

export type GroupBy = "channel" | "source" | "none";
export type OutlineColumn = "channel" | "source" | "unit" | "value" | "pts";

export interface OutlineSort {
  column: OutlineColumn;
  direction: "asc" | "desc";
}

export interface OutlineSeriesRow {
  kind: "series";
  key: string;
  ref: SeriesRef;
  path: string;
  depth: 0 | 1;
  channel: string;
  source: string;
  unit: string | null;
  pts: number;
  value: number | null;
}

export interface OutlineGroupRow {
  kind: "group";
  key: string;
  groupBy: "channel" | "source";
  label: string;
  expanded: boolean;
  refs: readonly SeriesRef[];
  childKeys: readonly string[];
  paths: readonly string[];
  aggregate: string;
  unit: string | null;
  unitConflict: boolean;
  pts: number;
  names: readonly string[];
  aliases: readonly string[];
}

export type OutlineRow = OutlineGroupRow | OutlineSeriesRow;

export interface OutlineOptions {
  filter: string;
  groupBy: GroupBy;
  sort: OutlineSort | null;
  collapsed: ReadonlySet<string>;
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

export function formatTableValue(value: number | null): string {
  return value === null ? "—" : value.toFixed(4);
}

export function buildOutlineRows(
  catalog: Catalog,
  options: OutlineOptions,
): OutlineRow[] {
  const filtered = filterCatalogSeries(catalog, options.filter);
  if (options.groupBy === "none") {
    return sortSeries(
      filtered.map((series) => seriesRow(catalog, series, 0)),
      options.sort,
    );
  }

  const groups = groupSeries(filtered, options.groupBy);
  let groupRows = groups.map(([label, members]) =>
    groupRow(catalog, options, label, members),
  );
  if (options.sort?.column === options.groupBy) {
    groupRows = stableSort(groupRows, options.sort, (row) => row.row.label);
  } else if (options.sort !== null) {
    for (const group of groupRows) {
      group.members = sortCatalogSeries(group.members, options.sort);
    }
  }

  const rows: OutlineRow[] = [];
  for (const group of groupRows) {
    if (group.members.length === 1) {
      rows.push(seriesRow(catalog, group.members[0] as CatalogSeries, 0));
      continue;
    }
    const expanded =
      options.filter.trim() !== "" || !options.collapsed.has(group.row.key);
    group.row.expanded = expanded;
    rows.push(group.row);
    if (expanded) {
      rows.push(
        ...group.members.map((series) => seriesRow(catalog, series, 1)),
      );
    }
  }
  return rows;
}

interface OutlineGroupBuild {
  row: OutlineGroupRow;
  members: CatalogSeries[];
}

function groupSeries(
  series: readonly CatalogSeries[],
  groupBy: "channel" | "source",
): [string, CatalogSeries[]][] {
  const groups = new Map<string, CatalogSeries[]>();
  for (const entry of series) {
    const label = groupBy === "channel" ? entry.channel : entry.sourceName;
    const members = groups.get(label) ?? [];
    members.push(entry);
    groups.set(label, members);
  }
  return [...groups.entries()];
}

function groupRow(
  catalog: Catalog,
  options: OutlineOptions,
  label: string,
  members: CatalogSeries[],
): OutlineGroupBuild {
  const groupBy = options.groupBy as "channel" | "source";
  const refs = members.map((series) => refForSeries(series));
  const units = new Set(
    members
      .map((series) => series.summary.unit)
      .filter((unit): unit is string => unit !== null),
  );
  const names =
    groupBy === "channel"
      ? [...new Set(members.map((series) => series.sourceChannel))]
      : [];
  const aliases =
    groupBy === "channel"
      ? members.map((series) => `${series.sourceName}: ${series.sourceChannel}`)
      : [];
  const row: OutlineGroupRow = {
    kind: "group",
    key: `group:${groupBy}:${label}`,
    groupBy,
    label,
    expanded: true,
    refs,
    childKeys: refs.map((ref) => catalog.refKey(ref)),
    paths: members.map((series) => series.path),
    aggregate:
      groupBy === "channel"
        ? `${String(new Set(refs.map((ref) => ref.source_key)).size)} srcs`
        : `${String(new Set(members.map((series) => series.channel)).size)} chs`,
    unit: units.size === 1 ? (members[0]?.summary.unit ?? null) : null,
    unitConflict: units.size > 1,
    pts: members.reduce(
      (total, series) => total + Number(series.summary.point_count),
      0,
    ),
    names,
    aliases,
  };
  return { row, members };
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
    unit: series.summary.unit,
    pts: Number(series.summary.point_count),
    value: series.summary.last_value,
  };
}

function refForSeries(series: CatalogSeries): SeriesRef {
  return { source_key: series.sourceKey, channel: series.channel };
}

function sortSeries(
  rows: OutlineSeriesRow[],
  sort: OutlineSort | null,
): OutlineSeriesRow[] {
  if (sort === null) return rows;
  return stableSort(rows, sort, (row) => row[sort.column]);
}

function sortCatalogSeries(
  series: CatalogSeries[],
  sort: OutlineSort,
): CatalogSeries[] {
  return stableSort([...series], sort, (entry) => {
    switch (sort.column) {
      case "channel":
        return entry.channel;
      case "source":
        return entry.sourceName;
      case "unit":
        return entry.summary.unit;
      case "pts":
        return Number(entry.summary.point_count);
      case "value":
        return entry.summary.last_value;
    }
  });
}

function stableSort<T>(
  values: T[],
  sort: OutlineSort,
  value: (entry: T) => string | number | null,
): T[] {
  return values
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const compared = compareValues(value(left.entry), value(right.entry));
      if (compared === 0) return left.index - right.index;
      return sort.direction === "asc" ? compared : -compared;
    })
    .map(({ entry }) => entry);
}

function compareValues(
  left: string | number | null,
  right: string | number | null,
): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  if (typeof left === "number" && typeof right === "number")
    return left - right;
  return String(left).localeCompare(String(right));
}
