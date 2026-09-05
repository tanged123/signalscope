import type { Catalog } from "./catalog";
import type {
  ColorAxis,
  PanelState,
  SeriesRef,
  SampleAxisSource,
} from "../generated/session";

export function axisRefs(axis: SampleAxisSource): readonly SeriesRef[] {
  return axis.kind === "time"
    ? []
    : axis.kind === "signal"
      ? [axis.ref]
      : axis.refs;
}

export function setXAxis(panel: PanelState, axis: SampleAxisSource): boolean {
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

export function setColorAxis(
  panel: PanelState,
  axis: ColorAxis | null,
): "binding" | "scale" | false {
  if (JSON.stringify(panel.color_axis) === JSON.stringify(axis)) return false;
  if (
    axis?.range != null &&
    (!axis.range.every(Number.isFinite) || axis.range[0] >= axis.range[1])
  )
    throw new Error("Color limits must be finite and increasing.");
  const bindingChanged =
    JSON.stringify(panel.color_axis?.source) !== JSON.stringify(axis?.source);
  panel.color_axis = structuredClone(axis);
  return bindingChanged ? "binding" : "scale";
}

export function removeAxisRef(panel: PanelState, deleted: SeriesRef): void {
  const prune = (axis: SampleAxisSource): SampleAxisSource | null => {
    const refs = axisRefs(axis).filter(
      (ref) =>
        ref.source_key !== deleted.source_key ||
        ref.channel !== deleted.channel,
    );
    if (refs.length === axisRefs(axis).length) return axis;
    return refs.length === 0 ? null : { kind: "bundle", refs };
  };
  setXAxis(panel, prune(panel.x_axis) ?? { kind: "time" });
  if (panel.color_axis != null) {
    const source = prune(panel.color_axis.source);
    setColorAxis(
      panel,
      source === null ? null : { ...panel.color_axis, source },
    );
  }
}

export interface LineGroup {
  xId: string;
  ids: string[];
  colorIds?: Record<string, string>;
  timeX?: boolean;
  timeColor?: boolean;
}

export interface LineBindings {
  ids: string[];
  xId: string | null;
  groups?: LineGroup[];
  missing: string[];
}

export function resolveLineBindings(
  axis: SampleAxisSource,
  ys: readonly { ref: SeriesRef; path: string }[],
  catalog: Catalog,
  color: ColorAxis | null = null,
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
  if (color !== null) {
    const colorRefs = axisRefs(color.source);
    const units = new Set<string | null>();
    const coloredGroups = new Map<string, LineGroup>();
    const baseGroups =
      axis.kind === "time"
        ? result.ids.map((id) => ({ xId: id, ids: [id] }))
        : (result.groups ?? []);
    for (const group of baseGroups) {
      const colorIds: Record<string, string> = {};
      const next: LineGroup = {
        ...group,
        ids: [...group.ids],
        colorIds,
        timeX: axis.kind === "time",
        timeColor: color.source.kind === "time",
      };
      for (const id of group.ids) {
        const y = ys.find(
          (entry) => catalog.get(entry.ref)?.summary.signal_id === id,
        );
        if (y === undefined) continue;
        if (color.source.kind === "time") {
          units.add("s");
          continue;
        }
        const candidates =
          color.source.kind === "signal"
            ? colorRefs
            : colorRefs.filter((ref) => ref.source_key === y.ref.source_key);
        if (candidates.length !== 1) {
          result.missing.push(
            `${y.path}: ${candidates.length === 0 ? "no" : "ambiguous"} C member for source ${y.ref.source_key}`,
          );
          continue;
        }
        const c = catalog.get(candidates[0] as SeriesRef);
        if (c === undefined) {
          result.missing.push(`${y.path}: C signal unavailable`);
          continue;
        }
        units.add(c.summary.unit);
        colorIds[id] = c.summary.signal_id;
      }
      coloredGroups.set(group.xId, next);
    }
    if (units.size > 1)
      result.missing.push(
        "C signals must use the same unit; convert units with a derived signal.",
      );
    result.groups =
      result.missing.length > 0 ? [] : [...coloredGroups.values()];
    result.xId = result.groups[0]?.xId ?? null;
  }
  return result;
}
