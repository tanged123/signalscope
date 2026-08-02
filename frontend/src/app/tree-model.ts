import type { Catalog, CatalogSeries } from "./catalog";
import { evaluateSelector } from "./selector";

export interface TreeLeaf {
  kind: "leaf";
  path: string;
  label: string;
  depth: number;
}

export interface TreeChannel {
  kind: "channel";
  path: string;
  label: string;
  depth: number;
  sourceKeys: readonly string[];
  expanded: boolean;
  members: readonly string[];
  names: readonly string[];
  unitConflict: boolean;
}

export type TreeRow = TreeLeaf | TreeChannel;

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

export function buildTreeRows(
  catalog: Catalog,
  collapsed: ReadonlySet<string>,
  filter: string,
): TreeRow[] {
  const query = filter.trim();
  const filtered = new Set(
    filterCatalogSeries(catalog, filter).map((series) =>
      catalog.refKey({
        source_key: series.sourceKey,
        channel: series.channel,
      }),
    ),
  );
  const rows: TreeRow[] = [];
  for (const channel of catalog.channels()) {
    const members = catalog
      .allSeries()
      .filter((series) => series.channel === channel.name)
      .sort((left, right) => left.path.localeCompare(right.path));
    const matching = members.filter((series) =>
      filtered.has(
        catalog.refKey({
          source_key: series.sourceKey,
          channel: series.channel,
        }),
      ),
    );
    if (matching.length === 0) continue;
    if (members.length === 1) {
      const series = members[0];
      if (series !== undefined) {
        rows.push({
          kind: "leaf",
          path: series.path,
          label: series.path,
          depth: 0,
        });
      }
      continue;
    }
    const path = `channel:${channel.name}`;
    const expanded = !collapsed.has(path) || query !== "";
    rows.push({
      kind: "channel",
      path,
      label: `${channel.name} — ${String(members.length)} srcs`,
      depth: 0,
      sourceKeys: channel.sourceKeys,
      expanded,
      members: matching.map((series) => series.path),
      names: channel.names,
      unitConflict: channel.unitConflict,
    });
    if (expanded) {
      for (const series of matching) {
        rows.push({
          kind: "leaf",
          path: series.path,
          label: series.path,
          depth: 1,
        });
      }
    }
  }
  return rows;
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
