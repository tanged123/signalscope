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
  setKey: string;
  bundleKey: string;
  depth: number;
  runCount: number;
  memberPaths: string[];
  expanded: boolean;
}

export interface TreeSet {
  key: string;
  label: string;
  prefixes: readonly string[];
}

export type TreeRow = TreeLeaf | TreeGroup | TreeBundle;

export function buildTreeRows(
  paths: readonly string[],
  collapsed: ReadonlySet<string>,
  filter: string,
  options?: {
    sets: readonly TreeSet[];
    expandedBundles: ReadonlySet<string>;
  },
): TreeRow[] {
  const query = filter.trim().toLowerCase();
  if (options !== undefined && options.sets.length > 0) {
    const prefixToSet = new Map<string, (typeof options.sets)[number]>();
    for (const set of options.sets) {
      for (const prefix of set.prefixes) {
        if (!prefixToSet.has(prefix)) prefixToSet.set(prefix, set);
      }
    }
    const grouped = new Map<string, Map<string, string[]>>();
    const rest: string[] = [];
    for (const path of paths) {
      const prefix = [...prefixToSet.keys()].find((item) =>
        path.startsWith(`${item}/`),
      );
      const set = prefix === undefined ? undefined : prefixToSet.get(prefix);
      if (prefix === undefined || set === undefined) {
        rest.push(path);
        continue;
      }
      const localPath = path.slice(prefix.length + 1);
      const setGroups = grouped.get(set.key) ?? new Map<string, string[]>();
      const members = setGroups.get(localPath) ?? [];
      members.push(path);
      setGroups.set(localPath, members);
      grouped.set(set.key, setGroups);
    }
    const rows: TreeRow[] = [];
    const bundleSets: TreeSet[] = [];
    for (const set of options.sets) {
      const setGroups = grouped.get(set.key);
      if (setGroups === undefined) continue;
      for (const [, members] of setGroups) {
        if (members.length < 2) rest.push(...members);
      }
      let hasBundle = false;
      for (const [, members] of setGroups) {
        if (members.length >= 2) {
          hasBundle = true;
          break;
        }
      }
      if (hasBundle) bundleSets.push(set);
    }
    const multi = bundleSets.length > 1;
    for (const set of bundleSets) {
      const setGroups = grouped.get(set.key);
      if (setGroups === undefined) continue;
      const setCollapsed = multi && collapsed.has(`set:${set.key}`);
      const base = multi ? 1 : 0;
      if (multi) {
        rows.push({
          kind: "group",
          path: `set:${set.key}`,
          label: set.label,
          depth: 0,
          expanded: !setCollapsed,
        });
      }
      if (setCollapsed) continue;
      const emittedGroups = new Set<string>();

      for (const [localPath, memberPaths] of [...setGroups].sort(
        ([left], [right]) => left.localeCompare(right),
      )) {
        if (memberPaths.length < 2) continue;
        const sorted = [...memberPaths].sort();
        const bundleMatches =
          query === "" || localPath.toLowerCase().includes(query);
        const matchingMembers = bundleMatches
          ? sorted
          : sorted.filter((path) => path.toLowerCase().includes(query));
        if (!bundleMatches && matchingMembers.length === 0) continue;
        const bundleKey = `${set.key}//${localPath}`;
        const expanded = options.expandedBundles.has(bundleKey);
        if (query !== "") {
          rows.push({
            kind: "bundle",
            path: localPath,
            label: localPath,
            setKey: set.key,
            bundleKey,
            depth: base,
            runCount: sorted.length,
            memberPaths: sorted,
            expanded,
          });
          if (expanded) {
            for (const member of matchingMembers) {
              rows.push({
                kind: "leaf",
                path: member,
                label: member.slice(0, member.length - localPath.length - 1),
                depth: base + 1,
              });
            }
          }
          continue;
        }
        appendBundleTree(
          rows,
          localPath,
          sorted,
          set.key,
          base,
          collapsed,
          options.expandedBundles,
          emittedGroups,
        );
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

function appendBundleTree(
  rows: TreeRow[],
  localPath: string,
  memberPaths: string[],
  setKey: string,
  base: number,
  collapsed: ReadonlySet<string>,
  expandedBundles: ReadonlySet<string>,
  emitted: Set<string>,
): void {
  const segments = localPath.split("/");
  let prefix = "";
  let hidden = false;
  for (let depth = 0; depth < segments.length - 1; depth += 1) {
    const segment = segments[depth] ?? "";
    prefix = prefix === "" ? segment : `${prefix}/${segment}`;
    const key = `${setKey}//${prefix}`;
    if (!hidden && !emitted.has(key)) {
      rows.push({
        kind: "group",
        path: key,
        label: segment,
        depth: base + depth,
        expanded: !collapsed.has(key),
      });
      emitted.add(key);
    }
    if (collapsed.has(key)) hidden = true;
  }
  if (hidden) return;
  const bundleKey = `${setKey}//${localPath}`;
  const expanded = expandedBundles.has(bundleKey);
  rows.push({
    kind: "bundle",
    path: localPath,
    label: segments[segments.length - 1] ?? localPath,
    setKey,
    bundleKey,
    depth: base + segments.length - 1,
    runCount: memberPaths.length,
    memberPaths,
    expanded,
  });
  if (!expanded) return;
  for (const member of memberPaths) {
    rows.push({
      kind: "leaf",
      path: member,
      label: member.slice(0, member.length - localPath.length - 1),
      depth: base + segments.length,
    });
  }
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
