import type { SeriesRef } from "../generated/session";
import type { Catalog, CatalogSeries } from "./catalog";
import { filterCatalogSeries } from "./tree-model";

export type TableGranularity = "series" | "channels";
export type TableColumn = "channel" | "source" | "unit" | "pts" | "value";

export interface TableSort {
  column: TableColumn;
  direction: "asc" | "desc";
}

export interface TableRow {
  key: string;
  refs: readonly SeriesRef[];
  channel: string;
  source: string;
  unit: string | null;
  pts: number;
  value: number | null;
}

export function buildTableRows(
  catalog: Catalog,
  filter: string,
  sort: TableSort | null,
  granularity: TableGranularity,
): TableRow[] {
  const filtered = filterCatalogSeries(catalog, filter);
  const rows =
    granularity === "series"
      ? filtered.map((series) => seriesRow(catalog, series))
      : channelRows(filtered);
  if (sort === null) return rows;

  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const compared = compareColumn(left.row, right.row, sort.column);
      if (compared === 0) return left.index - right.index;
      return sort.direction === "asc" ? compared : -compared;
    })
    .map(({ row }) => row);
}

function seriesRow(catalog: Catalog, series: CatalogSeries): TableRow {
  const ref = { source_key: series.sourceKey, channel: series.channel };
  return {
    key: catalog.refKey(ref),
    refs: [ref],
    channel: series.channel,
    source: series.sourceName,
    unit: series.summary.unit,
    pts: Number(series.summary.point_count),
    value: series.summary.last_value,
  };
}

function channelRows(series: readonly CatalogSeries[]): TableRow[] {
  const grouped = new Map<string, CatalogSeries[]>();
  for (const entry of series) {
    const members = grouped.get(entry.channel) ?? [];
    members.push(entry);
    grouped.set(entry.channel, members);
  }
  return [...grouped].map(([channel, members]) => {
    const refs = members.map((entry) => ({
      source_key: entry.sourceKey,
      channel: entry.channel,
    }));
    const units = new Set(members.map((entry) => entry.summary.unit));
    return {
      key: `channel:${channel}`,
      refs,
      channel,
      source: `${String(new Set(refs.map((ref) => ref.source_key)).size)} srcs`,
      unit: units.size === 1 ? (members[0]?.summary.unit ?? null) : null,
      pts: members.reduce(
        (total, entry) => total + Number(entry.summary.point_count),
        0,
      ),
      value: null,
    };
  });
}

function compareColumn(
  left: TableRow,
  right: TableRow,
  column: TableColumn,
): number {
  const leftValue = left[column];
  const rightValue = right[column];
  if (leftValue === null && rightValue === null) return 0;
  if (leftValue === null) return 1;
  if (rightValue === null) return -1;
  if (typeof leftValue === "number" && typeof rightValue === "number") {
    return leftValue - rightValue;
  }
  return String(leftValue).localeCompare(String(rightValue));
}
