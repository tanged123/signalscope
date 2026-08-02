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
    ) &&
    typeof value.reconcile_legacy === "boolean"
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
      (item): item is number => typeof item === "number",
    ) &&
    isNullable(
      value.dash,
      (item): item is string =>
        typeof item === "string" && ["solid", "dash", "dot"].includes(item),
    ) &&
    isNullable(
      value.width,
      (item): item is number => typeof item === "number",
    ) &&
    isNullable(
      value.opacity,
      (item): item is number => typeof item === "number",
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
    (value.domain === "time" ||
      value.domain === "frequency" ||
      value.domain === "distribution") &&
    typeof value.anchor === "number" &&
    typeof value.pinned_value === "number" &&
    typeof value.label === "string"
  );
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

function isPanel(value: unknown): boolean {
  const stringOrNull = (item: unknown): item is string =>
    typeof item === "string";
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    ["time", "xy", "fft", "histogram"].includes(String(value.mode)) &&
    (value.axis_style === "gutter" || value.axis_style === "inline") &&
    isNullable(value.x_ref, isSeriesRef) &&
    ["none", "time", "signal"].includes(String(value.color_axis)) &&
    isNullable(value.color_ref, isSeriesRef) &&
    Array.isArray(value.bindings) &&
    value.bindings.every(isBinding) &&
    ["focus", "source", "channel", "set", "attr"].includes(
      String(value.color_by),
    ) &&
    Array.isArray(value.overrides) &&
    value.overrides.every(isOverride) &&
    Array.isArray(value.focus) &&
    value.focus.every(isFocus) &&
    ["ghost", "all"].includes(String(value.ghost_mode)) &&
    ["none", "source", "channel"].includes(String(value.split_by)) &&
    isNullable(value.y_range, isNumberPair) &&
    isNullable(value.x_range, isNumberPair) &&
    isNullable(value.x_label, stringOrNull) &&
    isNullable(value.y_label, stringOrNull) &&
    isNullable(value.c_label, stringOrNull) &&
    isNullable(value.time_window, isNumberPair) &&
    Array.isArray(value.annotations) &&
    value.annotations.every(isAnnotation) &&
    typeof value.show_stats === "boolean"
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
    value.named_sets.every(
      (item) =>
        isRecord(item) &&
        typeof item.id === "string" &&
        typeof item.name === "string" &&
        (item.kind === "query" || item.kind === "pick") &&
        isNullable(
          item.selector,
          (candidate): candidate is string => typeof candidate === "string",
        ) &&
        Array.isArray(item.refs) &&
        item.refs.every(isSeriesRef),
    ) &&
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
