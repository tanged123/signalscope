import type { Binding, PanelState, SeriesRef } from "../generated/session";
import { removeAxisRef } from "./line-bindings";
import { sameRef } from "./series-overrides";

/**
 * What a panel plots. Adding any binding settles the panel's type choice, and
 * a pick binding that loses its last ref is dropped.
 */
export function addPickRef(panel: PanelState, ref: SeriesRef): boolean {
  let binding = panel.bindings.find((entry) => entry.kind === "pick");
  if (binding === undefined) {
    binding = { kind: "pick", selector: null, refs: [], set_id: null };
    panel.bindings.push(binding);
  }
  if (binding.refs.some((entry) => sameRef(entry, ref))) return false;
  binding.refs.push({ ...ref });
  panel.content_selection_pending = false;
  return true;
}

export function addQueryBinding(panel: PanelState, selector: string): boolean {
  return addBinding(panel, {
    kind: "query",
    selector,
    refs: [],
    set_id: null,
  });
}

export function addSetBinding(panel: PanelState, setId: string): boolean {
  return addBinding(panel, {
    kind: "set",
    selector: null,
    refs: [],
    set_id: setId,
  });
}

export function removeBindingAt(panel: PanelState, index: number): boolean {
  if (index < 0 || index >= panel.bindings.length) return false;
  panel.bindings.splice(index, 1);
  return true;
}

/**
 * Removes a series from a panel's picks, overrides and focus, and its
 * annotations when `path` is given. A deleted signal also leaves the axes.
 */
export function forgetSeries(
  panel: PanelState,
  ref: SeriesRef,
  path: string | undefined,
  deletingSignal: boolean,
): void {
  panel.bindings = panel.bindings
    .map((binding) =>
      binding.kind === "pick"
        ? {
            ...binding,
            refs: binding.refs.filter((entry) => !sameRef(entry, ref)),
          }
        : binding,
    )
    .filter((binding) => binding.kind !== "pick" || binding.refs.length > 0);
  panel.overrides = panel.overrides.filter(
    (entry) => entry.target_ref === null || !sameRef(entry.target_ref, ref),
  );
  panel.focus = panel.focus.filter(
    (entry) => entry.ref === null || !sameRef(entry.ref, ref),
  );
  if (deletingSignal) removeAxisRef(panel, ref);
  if (path !== undefined) {
    panel.annotations = panel.annotations.filter(
      (annotation) => annotation.series_path !== path,
    );
  }
}

function addBinding(panel: PanelState, binding: Binding): boolean {
  const duplicate = panel.bindings.some(
    (entry) =>
      entry.kind === binding.kind &&
      (binding.kind === "query"
        ? entry.selector === binding.selector
        : entry.set_id === binding.set_id),
  );
  if (duplicate) return false;
  panel.bindings.push(binding);
  panel.content_selection_pending = false;
  return true;
}
