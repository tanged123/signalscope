import type {
  PanelState,
  SeriesOverride,
  SeriesRef,
} from "../generated/session";

export type PanelSeriesAction =
  | "select"
  | "clear"
  | "dim"
  | "undim"
  | "hide"
  | "show";

function refKey(ref: SeriesRef): string {
  return JSON.stringify([ref.source_key, ref.channel]);
}

/** Last-wins overrides change one property without moving existing style rules. */
function setSeriesField(
  panel: PanelState,
  refs: readonly SeriesRef[],
  style: { visible: boolean } | { opacity: number },
): void {
  const field = "visible" in style ? "visible" : "opacity";
  const keys = new Set(refs.map(refKey));
  for (const override of panel.overrides) {
    if (override.target_ref !== null && keys.has(refKey(override.target_ref))) {
      override[field] = null;
    }
  }
  panel.overrides = panel.overrides.filter((override) =>
    [
      override.color_slot,
      override.dash,
      override.width,
      override.opacity,
      override.visible,
    ].some((property) => property !== null),
  );
  for (const ref of refs) {
    const override: SeriesOverride = {
      target_ref: { ...ref },
      target_selector: null,
      color_slot: null,
      dash: null,
      width: null,
      opacity: null,
      visible: null,
      ...style,
    };
    panel.overrides.push(override);
  }
}

export function toggleSeriesVisibility(
  panel: PanelState,
  ref: SeriesRef,
): void {
  const key = refKey(ref);
  let current = true;
  for (const override of panel.overrides) {
    if (
      override.target_ref !== null &&
      refKey(override.target_ref) === key &&
      override.visible !== null
    ) {
      current = override.visible;
    }
  }
  setSeriesField(panel, [ref], { visible: !current });
}

export function applyPanelSeriesAction(
  panel: PanelState,
  refs: readonly SeriesRef[],
  action: PanelSeriesAction,
): void {
  if (action === "select" || action === "clear") {
    panel.focus =
      action === "clear"
        ? []
        : refs.map((ref) => ({
            kind: "series",
            ref: { ...ref },
            source_key: null,
            channel: ref.channel,
          }));
    if (panel.focus.length > 0) panel.legend_hint_dismissed = true;
  } else if (action === "hide" || action === "show") {
    setSeriesField(panel, refs, { visible: action === "show" });
  } else {
    if (action === "undim") panel.ghost_mode = "all";
    setSeriesField(panel, refs, {
      opacity: action === "dim" ? panel.ghost_opacity : 1,
    });
  }
}
