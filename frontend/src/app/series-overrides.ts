import type {
  PanelState,
  SeriesOverride,
  SeriesRef,
  StyleDimension,
} from "../generated/session";

type StyleField = "color_slot" | "dash" | "width";

/**
 * Per-series and selector style overrides on a panel. A series override that
 * no longer overrides anything is removed, so a panel's override list only
 * holds rules that change what is drawn.
 */
export function patchSeriesOverride(
  panel: PanelState,
  ref: SeriesRef,
  patch: Partial<Pick<SeriesOverride, StyleField>>,
): void {
  const override = ensureSeriesOverride(panel, ref);
  if (patch.color_slot !== undefined) override.color_slot = patch.color_slot;
  if (patch.dash !== undefined) override.dash = patch.dash;
  if (patch.width !== undefined) override.width = patch.width;
  pruneEmptyOverride(panel, override);
}

/** Clears a series' style fields; false when it had no override. */
export function revertSeriesOverride(
  panel: PanelState,
  ref: SeriesRef,
): boolean {
  const override = panel.overrides.find(
    (entry) => entry.target_ref !== null && sameRef(entry.target_ref, ref),
  );
  if (override === undefined) return false;
  clearStyle(override);
  pruneEmptyOverride(panel, override);
  return true;
}

export function setSeriesVisible(
  panel: PanelState,
  ref: SeriesRef,
  visible: boolean,
): void {
  ensureSeriesOverride(panel, ref).visible = visible;
}

/**
 * Encodes a style property by a dimension. A dimension drives at most one
 * property, so taking one already in use swaps the two encodings. Returns
 * false when nothing changed.
 */
export function setEncoding(
  panel: PanelState,
  property: "color" | "dash" | "width",
  dimension: StyleDimension | null,
): boolean {
  const keys = {
    color: "color_by",
    dash: "dash_by",
    width: "width_by",
  } as const;
  const key = keys[property];
  const previous = panel[key];
  if (previous === dimension) return false;
  if (dimension !== null) {
    const other = (Object.keys(keys) as (keyof typeof keys)[]).find(
      (candidate) =>
        candidate !== property && panel[keys[candidate]] === dimension,
    );
    if (other !== undefined) panel[keys[other]] = previous;
  }
  panel[key] = dimension;
  return true;
}

export function addSelectorOverride(
  panel: PanelState,
  selector: string,
  style: Partial<Pick<SeriesOverride, StyleField | "opacity" | "visible">>,
): void {
  panel.overrides.push({
    target_ref: null,
    target_selector: selector,
    color_slot: style.color_slot ?? null,
    dash: style.dash ?? null,
    width: style.width ?? null,
    opacity: style.opacity ?? null,
    visible: style.visible ?? null,
  });
}

/** Clears every style field, keeping overrides that still set opacity or visibility. */
export function clearStyleOverrides(panel: PanelState): void {
  for (const override of panel.overrides) clearStyle(override);
  panel.overrides = panel.overrides.filter(
    (override) => override.opacity !== null || override.visible !== null,
  );
}

/** Clears one override's style fields; false when there is no such override. */
export function clearStyleOverride(panel: PanelState, index: number): boolean {
  const override = panel.overrides[index];
  if (override === undefined) return false;
  clearStyle(override);
  pruneEmptyOverride(panel, override);
  return true;
}

export function sameRef(
  left: SeriesRef | null | undefined,
  right: SeriesRef | null | undefined,
): boolean {
  return (
    left != null &&
    right != null &&
    left.source_key === right.source_key &&
    left.channel === right.channel
  );
}

function clearStyle(override: SeriesOverride): void {
  override.color_slot = null;
  override.dash = null;
  override.width = null;
}

function ensureSeriesOverride(
  panel: PanelState,
  ref: SeriesRef,
): SeriesOverride {
  const existing = panel.overrides.find(
    (entry) => entry.target_ref !== null && sameRef(entry.target_ref, ref),
  );
  if (existing !== undefined) return existing;
  const created: SeriesOverride = {
    target_ref: { ...ref },
    target_selector: null,
    color_slot: null,
    dash: null,
    width: null,
    opacity: null,
    visible: null,
  };
  panel.overrides.push(created);
  return created;
}

function pruneEmptyOverride(panel: PanelState, override: SeriesOverride): void {
  if (
    override.color_slot !== null ||
    override.dash !== null ||
    override.width !== null ||
    override.opacity !== null ||
    override.visible !== null
  ) {
    return;
  }
  const index = panel.overrides.indexOf(override);
  if (index !== -1) panel.overrides.splice(index, 1);
}
