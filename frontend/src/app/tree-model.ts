export interface TreeLeaf {
  kind: "leaf";
  path: string;
  label: string;
  depth: number;
}

export interface TreeGroup {
  kind: "group";
  path: string;
  label: string;
  depth: number;
  expanded: boolean;
}

export interface TreeBundle {
  kind: "bundle";
  path: string;
  label: string;
  depth: 0;
  runCount: number;
  memberPaths: string[];
  expanded: boolean;
}

export type TreeRow = TreeLeaf | TreeGroup | TreeBundle;

export function buildTreeRows(
  paths: readonly string[],
  collapsed: ReadonlySet<string>,
  filter: string,
  options?: {
    setPrefixes: readonly string[];
    expandedBundles: ReadonlySet<string>;
  },
): TreeRow[] {
  const query = filter.trim().toLowerCase();
  if (options !== undefined && options.setPrefixes.length > 0) {
    const grouped = new Map<string, string[]>();
    const rest: string[] = [];
    for (const path of paths) {
      const prefix = options.setPrefixes.find((item) =>
        path.startsWith(`${item}/`),
      );
      if (prefix === undefined) {
        rest.push(path);
        continue;
      }
      const localPath = path.slice(prefix.length + 1);
      const members = grouped.get(localPath) ?? [];
      members.push(path);
      grouped.set(localPath, members);
    }
    const rows: TreeRow[] = [];
    for (const [localPath, memberPaths] of [...grouped].sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      if (memberPaths.length < 2) {
        rest.push(...memberPaths);
        continue;
      }
      const bundleMatches =
        query === "" || localPath.toLowerCase().includes(query);
      const matchingMembers = bundleMatches
        ? memberPaths
        : memberPaths.filter((path) => path.toLowerCase().includes(query));
      if (!bundleMatches && matchingMembers.length === 0) continue;
      const sorted = [...memberPaths].sort();
      const expanded = options.expandedBundles.has(localPath);
      rows.push({
        kind: "bundle",
        path: localPath,
        label: localPath,
        depth: 0,
        runCount: sorted.length,
        memberPaths: sorted,
        expanded,
      });
      if (expanded) {
        for (const member of [...matchingMembers].sort()) {
          rows.push({
            kind: "leaf",
            path: member,
            label: member.slice(0, member.length - localPath.length - 1),
            depth: 1,
          });
        }
      }
    }
    return [...rows, ...buildTreeRows(rest.sort(), collapsed, filter)];
  }
  if (query !== "") {
    return [...paths]
      .filter((path) => path.toLowerCase().includes(query))
      .sort()
      .map((path) => ({ kind: "leaf", path, label: path, depth: 0 }));
  }
  const rows: TreeRow[] = [];
  const emitted = new Set<string>();
  for (const path of [...paths].sort()) {
    const segments = path.split("/");
    let prefix = "";
    let hidden = false;
    for (let depth = 0; depth < segments.length - 1; depth += 1) {
      const segment = segments[depth] ?? "";
      prefix = prefix === "" ? segment : `${prefix}/${segment}`;
      if (!hidden && !emitted.has(prefix)) {
        rows.push({
          kind: "group",
          path: prefix,
          label: segment,
          depth,
          expanded: !collapsed.has(prefix),
        });
        emitted.add(prefix);
      }
      if (collapsed.has(prefix)) hidden = true;
    }
    if (!hidden) {
      rows.push({
        kind: "leaf",
        path,
        label: segments[segments.length - 1] ?? path,
        depth: segments.length - 1,
      });
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
  rowCount: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan = 10,
): VirtualSlice {
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const visible = Math.ceil(viewportHeight / rowHeight) + overscan * 2;
  const end = Math.min(rowCount, start + visible);
  return {
    start,
    end,
    topPadding: start * rowHeight,
    totalHeight: rowCount * rowHeight,
  };
}
