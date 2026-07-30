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

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
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

function isNullable<T>(
  value: unknown,
  predicate: (candidate: unknown) => candidate is T,
): value is T | null {
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

function isSeries(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.color_slot === "number" &&
    (value.dash === "solid" || value.dash === "dash" || value.dash === "dot") &&
    typeof value.width === "number" &&
    typeof value.visible === "boolean"
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

function isPanel(value: unknown): boolean {
  const stringOrNull = (item: unknown): item is string =>
    typeof item === "string";
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    ["time", "xy", "fft", "histogram"].includes(String(value.mode)) &&
    (value.axis_style === "gutter" || value.axis_style === "inline") &&
    isNullable(value.x_signal, stringOrNull) &&
    isNullable(value.color_signal, stringOrNull) &&
    typeof value.color_by_time === "boolean" &&
    Array.isArray(value.series) &&
    value.series.every(isSeries) &&
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
    isStringArray(value.favorites) &&
    Array.isArray(value.derived) &&
    value.derived.every(
      (item) =>
        isRecord(item) &&
        typeof item.path === "string" &&
        typeof item.expr === "string",
    ) &&
    Array.isArray(value.sources) &&
    value.sources.every(isSource)
  );
}
