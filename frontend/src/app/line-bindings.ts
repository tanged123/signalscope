import type { Catalog } from "./catalog";
import type { PanelState, SeriesRef, XAxisSource } from "../generated/session";

export function axisRefs(axis: XAxisSource): readonly SeriesRef[] {
  return axis.kind === "time"
    ? []
    : axis.kind === "signal"
      ? [axis.ref]
      : axis.refs;
}

export function setXAxis(panel: PanelState, axis: XAxisSource): boolean {
  if (JSON.stringify(panel.x_axis) === JSON.stringify(axis)) return false;
  panel.x_axis = structuredClone(axis);
  panel.x_range = null;
  panel.x_label = null;
  panel.annotations = panel.annotations.map((annotation) => ({
    ...annotation,
    pinned_x: null,
  }));
  return true;
}

export interface LineBindings {
  ids: string[];
  xId: string | null;
  groups?: { xId: string; ids: string[] }[];
  missing: string[];
}

export function resolveLineBindings(
  axis: XAxisSource,
  ys: readonly { ref: SeriesRef; path: string }[],
  catalog: Catalog,
): LineBindings {
  const result: LineBindings = { ids: [], xId: null, missing: [] };
  const groups = new Map<string, string[]>();
  const refs = axisRefs(axis);
  const bySource = new Map<string, SeriesRef[]>();
  for (const ref of refs) {
    const members = bySource.get(ref.source_key) ?? [];
    members.push(ref);
    bySource.set(ref.source_key, members);
  }
  for (const y of ys) {
    const signal = catalog.get(y.ref);
    if (signal === undefined) {
      result.missing.push(y.path);
      continue;
    }
    result.ids.push(signal.summary.signal_id);
    if (axis.kind === "time") continue;
    const candidates =
      axis.kind === "signal" ? refs : (bySource.get(signal.sourceKey) ?? []);
    if (candidates.length !== 1) {
      result.missing.push(
        `${y.path}: ${candidates.length === 0 ? "no" : "ambiguous"} X member for source ${signal.sourceKey}`,
      );
      continue;
    }
    const x = catalog.get(candidates[0] as SeriesRef);
    if (x === undefined) {
      result.missing.push(`${y.path}: X signal unavailable`);
      continue;
    }
    const ids = groups.get(x.summary.signal_id) ?? [];
    ids.push(signal.summary.signal_id);
    groups.set(x.summary.signal_id, ids);
  }
  if (axis.kind !== "time") {
    result.groups =
      result.missing.length > 0
        ? []
        : [...groups].map(([xId, ids]) => ({ xId, ids }));
    result.xId = result.groups[0]?.xId ?? null;
  }
  return result;
}
