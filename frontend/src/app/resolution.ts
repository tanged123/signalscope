import type { DashStyle } from "../generated/session";
import type {
  FocusEntry,
  NamedSet,
  PanelState,
  SeriesOverride,
  SeriesRef,
} from "../generated/session";
import type { Catalog, CatalogSeries } from "./catalog";
import { evaluateSelector } from "./selector";

export interface ResolvedSeries {
  ref: SeriesRef;
  path: string;
  colorSlot: number;
  dash: DashStyle;
  width: number;
  opacity: number;
  visible: boolean;
  focused: boolean;
}

export function overrideFor(
  panel: PanelState,
  ref: SeriesRef,
): SeriesOverride | undefined {
  return panel.overrides.find(
    (override) =>
      override.target_ref !== null && sameRef(override.target_ref, ref),
  );
}

export function resolvePanel(
  catalog: Catalog,
  panel: PanelState,
  namedSets: readonly NamedSet[],
): ResolvedSeries[] {
  const refs: SeriesRef[] = [];
  const seen = new Set<string>();
  const add = (ref: SeriesRef): void => {
    const key = catalog.refKey(ref);
    if (seen.has(key) || catalog.get(ref) === undefined) return;
    seen.add(key);
    refs.push({ ...ref });
  };
  for (const binding of panel.bindings) {
    if (binding.kind === "pick") {
      binding.refs.forEach(add);
    } else if (binding.kind === "set") {
      const set = namedSets.find((entry) => entry.id === binding.set_id);
      if (set?.kind === "pick") set.refs.forEach(add);
      else if (set?.kind === "query" && set.selector !== null) {
        addSelector(catalog, set.selector, add);
      }
    } else if (binding.selector !== null) {
      addSelector(catalog, binding.selector, add);
    }
  }
  const claimed = new Set<number>();
  for (const override of panel.overrides) {
    if (override.color_slot !== null) claimed.add(override.color_slot);
  }
  return refs.map((ref) => {
    const override = overrideFor(panel, ref);
    let colorSlot = override?.color_slot ?? null;
    if (colorSlot === null) {
      colorSlot = 1;
      while (claimed.has(colorSlot)) colorSlot += 1;
      claimed.add(colorSlot);
    }
    const series = catalog.get(ref) as CatalogSeries;
    return {
      ref,
      path: series.path,
      colorSlot,
      dash: override?.dash ?? "solid",
      width: override?.width ?? 1.4,
      opacity: override?.opacity ?? 1,
      visible: override?.visible ?? true,
      focused:
        panel.focus.length === 0 ||
        panel.focus.some((entry) => matchesFocus(entry, ref)),
    };
  });
}

function addSelector(
  catalog: Catalog,
  input: string,
  add: (ref: SeriesRef) => void,
): void {
  const match = evaluateSelector(catalog, input);
  if (match === null) return;
  for (const series of match.series) {
    add({ source_key: series.sourceKey, channel: series.channel });
  }
}

function sameRef(left: SeriesRef, right: SeriesRef): boolean {
  return left.source_key === right.source_key && left.channel === right.channel;
}

function matchesFocus(entry: FocusEntry, ref: SeriesRef): boolean {
  if (entry.kind === "series") {
    return entry.ref !== null && sameRef(entry.ref, ref);
  }
  if (entry.kind === "source") return entry.source_key === ref.source_key;
  return entry.channel === ref.channel;
}
