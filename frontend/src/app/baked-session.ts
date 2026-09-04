import { SESSION_SCHEMA_VERSION, type Session } from "../generated/session";

export function parseBakedSession(sessionJson: string): Session {
  const parsed: unknown = JSON.parse(sessionJson);
  if (!isRecord(parsed)) throw new Error("snapshot session must be an object");
  if (parsed.app !== "signalscope") {
    throw new Error(
      `snapshot session has unexpected app: ${String(parsed.app)}`,
    );
  }
  if (parsed.schema_version !== SESSION_SCHEMA_VERSION) {
    throw new Error(
      `snapshot session schema ${String(parsed.schema_version)} does not match this build (${String(SESSION_SCHEMA_VERSION)})`,
    );
  }
  normalizeOptionalAnnotationFields(parsed);
  if (!isSession(parsed)) {
    throw new Error("snapshot session has an invalid structure");
  }
  return parsed;
}

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSource(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.key === "string" &&
    typeof value.path === "string" &&
    typeof value.prefix === "string" &&
    isNullable(
      value.provider_id,
      (item): item is string => typeof item === "string",
    ) &&
    isNullable(
      value.decode_provenance,
      (item): item is string => typeof item === "string",
    )
  );
}

function isNumberPair(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((item) => typeof item === "number")
  );
}

function isNullable(
  value: unknown,
  predicate: (candidate: unknown) => boolean,
): boolean {
  return value === null || predicate(value);
}

function isLinkedTime(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.t0 === "number" &&
    typeof value.t1 === "number" &&
    typeof value.linked === "boolean" &&
    typeof value.paused === "boolean" &&
    isNullable(
      value.cursorT,
      (item): item is number => typeof item === "number",
    ) &&
    (value.mode === "fixed" || value.mode === "follow")
  );
}

function isSeriesRef(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.source_key === "string" &&
    typeof value.channel === "string"
  );
}

function isXAxisSource(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === "time") return !("ref" in value);
  if (value.kind === "signal") return isSeriesRef(value.ref);
  return false;
}

function isBinding(value: unknown): boolean {
  return (
    isRecord(value) &&
    ["query", "pick", "set"].includes(String(value.kind)) &&
    isNullable(
      value.selector,
      (item): item is string => typeof item === "string",
    ) &&
    Array.isArray(value.refs) &&
    value.refs.every(isSeriesRef) &&
    isNullable(value.set_id, (item): item is string => typeof item === "string")
  );
}

function isOverride(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNullable(value.target_ref, isSeriesRef) &&
    isNullable(
      value.target_selector,
      (item): item is string => typeof item === "string",
    ) &&
    isNullable(
      value.color_slot,
      (item): item is number =>
        typeof item === "number" &&
        Number.isFinite(item) &&
        item >= 1 &&
        item <= 8,
    ) &&
    isNullable(
      value.dash,
      (item): item is string =>
        typeof item === "string" && ["solid", "dash", "dot"].includes(item),
    ) &&
    isNullable(
      value.width,
      (item): item is number =>
        typeof item === "number" &&
        Number.isFinite(item) &&
        item >= 0.5 &&
        item <= 4,
    ) &&
    isNullable(
      value.opacity,
      (item): item is number =>
        typeof item === "number" &&
        Number.isFinite(item) &&
        item >= 0 &&
        item <= 1,
    ) &&
    isNullable(
      value.visible,
      (item): item is boolean => typeof item === "boolean",
    )
  );
}

function isAnnotation(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.series_path === "string" &&
    typeof value.anchor === "number" &&
    (value.pinned_x === undefined ||
      isNullable(value.pinned_x, (item) => typeof item === "number")) &&
    typeof value.pinned_value === "number" &&
    typeof value.label === "string" &&
    isNumberPair(value.offset)
  );
}

function normalizeOptionalAnnotationFields(session: JsonObject): void {
  if (!Array.isArray(session.tabs)) return;
  for (const tab of session.tabs) {
    if (!isRecord(tab) || !Array.isArray(tab.panels)) continue;
    for (const panel of tab.panels) {
      if (!isRecord(panel) || !Array.isArray(panel.annotations)) continue;
      for (const annotation of panel.annotations) {
        if (isRecord(annotation) && annotation.pinned_x === undefined) {
          annotation.pinned_x = null;
        }
      }
    }
  }
}

function isFocus(value: unknown): boolean {
  return (
    isRecord(value) &&
    ["series", "source", "channel"].includes(String(value.kind)) &&
    isNullable(value.ref, isSeriesRef) &&
    isNullable(
      value.source_key,
      (item): item is string => typeof item === "string",
    ) &&
    isNullable(
      value.channel,
      (item): item is string => typeof item === "string",
    )
  );
}

function isNamedSet(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    (value.kind === "query" || value.kind === "pick") &&
    isNullable(
      value.selector,
      (candidate): candidate is string => typeof candidate === "string",
    ) &&
    Array.isArray(value.refs) &&
    value.refs.every(isSeriesRef)
  );
}

function isStyleDimension(value: unknown): boolean {
  return (
    typeof value === "string" &&
    ["focus", "source", "channel", "set", "attr"].includes(value)
  );
}

function isStatColumn(value: unknown): boolean {
  return (
    typeof value === "string" &&
    ["min", "max", "mean", "rms", "cursor", "n"].includes(value)
  );
}

function isPanel(value: unknown): boolean {
  const stringOrNull = (item: unknown): item is string =>
    typeof item === "string";
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    (value.axis_style === "gutter" || value.axis_style === "inline") &&
    Array.isArray(value.bindings) &&
    value.bindings.every(isBinding) &&
    isNullable(value.color_by, isStyleDimension) &&
    isNullable(value.dash_by, isStyleDimension) &&
    isNullable(value.width_by, isStyleDimension) &&
    typeof value.line_width === "number" &&
    typeof value.ghost_opacity === "number" &&
    Number.isFinite(value.ghost_opacity) &&
    value.ghost_opacity >= 0 &&
    value.ghost_opacity <= 1 &&
    Array.isArray(value.overrides) &&
    value.overrides.every(isOverride) &&
    Array.isArray(value.focus) &&
    value.focus.every(isFocus) &&
    ["ghost", "all"].includes(String(value.ghost_mode)) &&
    ["badge", "keys", "roster", "rail"].includes(String(value.legend_state)) &&
    isNullable(value.legend_position, isNumberPair) &&
    isNullable(value.legend_size, isNumberPair) &&
    isNullable(
      value.legend_anchor,
      (item): item is string =>
        typeof item === "string" &&
        ["top_left", "top_right", "bottom_left", "bottom_right"].includes(item),
    ) &&
    isNullable(
      value.legend_dock,
      (item): item is string =>
        typeof item === "string" &&
        ["left", "right", "top", "bottom"].includes(item),
    ) &&
    typeof value.legend_hint_dismissed === "boolean" &&
    isXAxisSource(value.x_axis) &&
    isNullable(value.y_range, isNumberPair) &&
    isNullable(value.x_range, isNumberPair) &&
    isNullable(value.x_label, stringOrNull) &&
    isNullable(value.y_label, stringOrNull) &&
    isNullable(value.time_window, isNumberPair) &&
    Array.isArray(value.annotations) &&
    value.annotations.every(isAnnotation) &&
    ["labels", "markers", "hidden"].includes(
      String(value.annotation_display),
    ) &&
    typeof value.show_stats === "boolean" &&
    Array.isArray(value.stat_columns) &&
    value.stat_columns.every(isStatColumn) &&
    new Set(value.stat_columns).size === value.stat_columns.length &&
    (value.stats_sort === null ||
      (isStatColumn(value.stats_sort) &&
        value.stat_columns.includes(value.stats_sort))) &&
    typeof value.stats_sort_descending === "boolean"
  );
}

function isLayoutRow(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.height === "number" &&
    Array.isArray(value.panels) &&
    value.panels.every(
      (panel) =>
        isRecord(panel) &&
        typeof panel.panel_id === "string" &&
        typeof panel.width === "number",
    )
  );
}

function isTab(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    ["none", "track", "measure"].includes(String(value.cursor_mode)) &&
    isNullable(
      value.focused_panel_id,
      (item): item is string => typeof item === "string",
    ) &&
    isNullable(
      value.maximized_panel_id,
      (item): item is string => typeof item === "string",
    ) &&
    Array.isArray(value.panels) &&
    value.panels.every(isPanel) &&
    Array.isArray(value.layout) &&
    value.layout.every(isLayoutRow)
  );
}

function isSession(value: JsonObject): value is JsonObject & Session {
  return (
    (value.theme === "dark" || value.theme === "light") &&
    isLinkedTime(value.linked_time) &&
    typeof value.active_tab_id === "string" &&
    Array.isArray(value.tabs) &&
    value.tabs.every(isTab) &&
    Array.isArray(value.named_sets) &&
    value.named_sets.every(isNamedSet) &&
    Array.isArray(value.derived) &&
    value.derived.every(
      (item) =>
        isRecord(item) &&
        typeof item.path === "string" &&
        typeof item.expr === "string",
    ) &&
    Array.isArray(value.derived_bundles) &&
    value.derived_bundles.every(
      (item) =>
        isRecord(item) &&
        typeof item.name === "string" &&
        typeof item.expr === "string",
    ) &&
    Array.isArray(value.sources) &&
    value.sources.every(isSource)
  );
}
