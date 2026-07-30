interface TreeLeaf {
  kind: "leaf";
  path: string;
  label: string;
  depth: number;
  runCount?: number;
  memberPaths?: string[];
}

interface TreeGroup {
  kind: "group";
  path: string;
  label: string;
  depth: number;
  expanded: boolean;
}

export type TreeRow = TreeLeaf | TreeGroup;

export function buildTreeRows(
  paths: readonly string[],
  collapsed: ReadonlySet<string>,
  filter: string,
  options?: { setPrefixes: readonly string[] },
): TreeRow[] {
  const query = filter.trim().toLowerCase();
  if (options !== undefined) {
    const grouped = new Map<string, string[]>();
    for (const path of paths) {
      const prefix = options.setPrefixes.find((item) =>
        path.startsWith(`${item}/`),
      );
      const localPath =
        prefix === undefined ? path : path.slice(prefix.length + 1);
      const members = grouped.get(localPath) ?? [];
      members.push(path);
      grouped.set(localPath, members);
    }
    return [...grouped]
      .filter(([path]) => query === "" || path.toLowerCase().includes(query))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, memberPaths]) => ({
        kind: "leaf",
        path,
        label: path,
        depth: 0,
        runCount: memberPaths.length,
        memberPaths,
      }));
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
