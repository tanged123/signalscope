import type {
  DashStyle,
  FocusEntry,
  NamedSet,
  PanelState,
  SeriesOverride,
  SeriesRef,
} from "../generated/session";
import type { Catalog, CatalogSeries } from "./catalog";
import { parseSelector, seriesMatches, type Selector } from "./selector";

type SeriesDisplay = "focus" | "rule" | "ghost";

export interface ResolvedSeries {
  ref: SeriesRef;
  path: string;
  display: SeriesDisplay;
  hue: number | null;
  dash: DashStyle;
  width: number;
  opacity: number;
  visible: boolean;
  focused: boolean;
  overridden: boolean;
}

interface ResolvedRef {
  ref: SeriesRef;
  series: CatalogSeries;
  bindingIndex: number;
}

interface PreparedOverride {
  index: number;
  override: SeriesOverride;
  selector: Selector | null;
}

export function overrideFor(
  panel: PanelState | undefined,
  ref: SeriesRef,
): SeriesOverride | undefined {
  return panel?.overrides.find(
    (override) =>
      override.target_ref !== null && sameRef(override.target_ref, ref),
  );
}

export function resolvePanel(
  catalog: Catalog,
  panel: PanelState,
  namedSets: readonly NamedSet[],
): ResolvedSeries[] {
  const refs = resolveRefs(catalog, panel, namedSets);
  const focus: readonly FocusEntry[] =
    panel.focus.length === 0 && panel.ghost_mode === "ghost" && refs[0]
      ? [
          {
            kind: "source",
            ref: null,
            source_key: refs[0].ref.source_key,
            channel: null,
          },
        ]
      : panel.focus;
  const focused = refs.map(({ ref }) => matchesAnyFocus(focus, ref));
  const display = focused.map((isFocused) =>
    isFocused
      ? ("focus" as const)
      : panel.ghost_mode === "ghost"
        ? ("ghost" as const)
        : ("rule" as const),
  );
  const hues = assignHues({ ...panel, focus: [...focus] }, refs, focused);
  const overrides = prepareOverrides(panel.overrides);

  return refs.map(({ ref, series }, index) => {
    let hue: number | null = hues[index] ?? 1;
    let dash: DashStyle = "solid";
    let width = 1.4;
    let opacity = 1;
    let visible = true;
    let overridden = false;

    for (const prepared of overrides) {
      if (!matchesOverride(prepared, series, ref)) continue;
      overridden = true;
      const override = prepared.override;
      if (override.color_slot !== null) hue = hueForSlot(override.color_slot);
      if (override.dash !== null) dash = override.dash;
      if (override.width !== null) width = override.width;
      if (override.opacity !== null) opacity = override.opacity;
      if (override.visible !== null) visible = override.visible;
    }

    if (display[index] === "ghost") {
      hue = null;
      dash = "solid";
      width = 1;
      opacity = 0.5;
    }

    return {
      ref,
      path: series.path,
      display: display[index] ?? "rule",
      hue,
      dash,
      width,
      opacity,
      visible,
      focused: focused[index] ?? false,
      overridden,
    };
  });
}

export interface DimensionCounts {
  sources: number;
  channels: number;
}

export function dimensionCounts(
  resolved: readonly ResolvedSeries[],
): DimensionCounts {
  return {
    sources: new Set(resolved.map((series) => series.ref.source_key)).size,
    channels: new Set(resolved.map((series) => series.ref.channel)).size,
  };
}

export function appliedOverrides(
  catalog: Catalog,
  panel: PanelState,
): { index: number; override: SeriesOverride; matchCount: number }[] {
  const refs = resolveRefs(catalog, panel, []).map(({ ref, series }) => ({
    ref,
    series,
  }));
  const prepared = prepareOverrides(panel.overrides);
  return prepared.map(({ index, override }) => ({
    index,
    override,
    matchCount: refs.filter(({ ref, series }) => {
      const candidate = prepared.find((entry) => entry.index === index);
      return candidate !== undefined && matchesOverride(candidate, series, ref);
    }).length,
  }));
}

function resolveRefs(
  catalog: Catalog,
  panel: PanelState,
  namedSets: readonly NamedSet[],
): ResolvedRef[] {
  const resolved: ResolvedRef[] = [];
  const seen = new Set<string>();
  const add = (ref: SeriesRef, bindingIndex: number): void => {
    const key = catalog.refKey(ref);
    const series = catalog.get(ref);
    if (seen.has(key) || series === undefined) return;
    seen.add(key);
    resolved.push({ ref: { ...ref }, series, bindingIndex });
  };
  panel.bindings.forEach((binding, bindingIndex) => {
    if (binding.kind === "pick") {
      binding.refs.forEach((ref) => add(ref, bindingIndex));
    } else if (binding.kind === "set") {
      const set = namedSets.find((entry) => entry.id === binding.set_id);
      if (set?.kind === "pick") {
        set.refs.forEach((ref) => add(ref, bindingIndex));
      } else if (set?.kind === "query" && set.selector !== null) {
        addSelector(catalog, set.selector, (ref) => add(ref, bindingIndex));
      }
    } else if (binding.selector !== null) {
      addSelector(catalog, binding.selector, (ref) => add(ref, bindingIndex));
    }
  });
  return resolved;
}

function addSelector(
  catalog: Catalog,
  input: string,
  add: (ref: SeriesRef) => void,
): void {
  const parsed = parseSelector(input);
  if (!parsed.ok) return;
  for (const series of catalog.allSeries()) {
    if (seriesMatches(parsed.selector, series)) {
      add({ source_key: series.sourceKey, channel: series.channel });
    }
  }
}

function assignHues(
  panel: PanelState,
  refs: readonly ResolvedRef[],
  focused: readonly boolean[],
): number[] {
  const values = new Map<string, number>();
  const hues: number[] = [];
  refs.forEach(({ ref, series, bindingIndex }, index) => {
    const value = dimensionValue(
      panel,
      ref,
      series,
      bindingIndex,
      focused[index] ?? false,
    );
    let hue = values.get(value);
    if (hue === undefined) {
      hue = (values.size % 7) + 1;
      values.set(value, hue);
    }
    hues.push(hue);
  });
  return hues;
}

function dimensionValue(
  panel: PanelState,
  ref: SeriesRef,
  series: CatalogSeries,
  bindingIndex: number,
  isFocused: boolean,
): string {
  if (panel.color_by === "channel") return `channel:${series.channel}`;
  if (panel.color_by === "set") return `set:${String(bindingIndex)}`;
  if (panel.color_by === "attr") {
    return `attr:${series.summary.unit ?? "—"}`;
  }
  if (panel.color_by === "focus") {
    const focusIndex = panel.focus.findIndex((entry) =>
      matchesFocus(entry, ref),
    );
    if (isFocused && focusIndex !== -1) return `focus:${String(focusIndex)}`;
  }
  return `source:${series.sourceKey}`;
}

function prepareOverrides(
  overrides: readonly SeriesOverride[],
): PreparedOverride[] {
  return overrides.flatMap((override, index) => {
    if (override.target_selector === null) {
      return [
        {
          index,
          override,
          selector: null,
        },
      ];
    }
    const parsed = parseSelector(override.target_selector);
    return [
      {
        index,
        override,
        selector: parsed.ok ? parsed.selector : null,
      },
    ];
  });
}

function matchesOverride(
  prepared: PreparedOverride,
  series: CatalogSeries,
  ref: SeriesRef,
): boolean {
  const targetRef = prepared.override.target_ref;
  const refMatches = targetRef !== null && sameRef(targetRef, ref);
  const selectorMatches =
    prepared.override.target_selector !== null &&
    prepared.selector !== null &&
    seriesMatches(prepared.selector, series);
  return refMatches || selectorMatches;
}

function hueForSlot(slot: number): number {
  return ((Math.max(1, Math.trunc(slot)) - 1) % 7) + 1;
}

function sameRef(left: SeriesRef, right: SeriesRef): boolean {
  return left.source_key === right.source_key && left.channel === right.channel;
}

function matchesAnyFocus(
  entries: readonly FocusEntry[],
  ref: SeriesRef,
): boolean {
  return entries.some((entry) => matchesFocus(entry, ref));
}

function matchesFocus(entry: FocusEntry, ref: SeriesRef): boolean {
  if (entry.kind === "series") {
    return entry.ref !== null && sameRef(entry.ref, ref);
  }
  if (entry.kind === "source") return entry.source_key === ref.source_key;
  return entry.channel === ref.channel;
}
