import type { Catalog } from "../app/catalog";
import type {
  NamedSet,
  SeriesRef,
  SampleAxisSource,
} from "../generated/session";
import { parseSelector, seriesMatches } from "../app/selector";
import {
  SIGNAL_DRAG_TYPE,
  SET_DRAG_TYPE,
  hasDragType,
  dragData,
  parseSignalPayload,
  parseSetPayload,
} from "./panel-shell";

export function bindAxisDrop(
  panel: HTMLElement,
  catalog: () => Catalog,
  sets: () => readonly NamedSet[],
  select: (axis: SampleAxisSource) => void,
  selectColor?: (axis: SampleAxisSource) => void,
): () => void {
  const abort = new AbortController();
  const options = { capture: true, signal: abort.signal };
  const strip = document.createElement("div");
  strip.className = "xy-drop-strip";
  strip.textContent = "⇄ drop here — use as X axis · bundles pair by source";
  strip.hidden = true;
  panel.append(strip);
  const reset = (): void => {
    strip.hidden = true;
    panel.classList.remove("drop-target", "drop-x");
  };
  panel.addEventListener(
    "dragover",
    (event) => {
      if (
        !hasDragType(event, SIGNAL_DRAG_TYPE) &&
        !hasDragType(event, SET_DRAG_TYPE)
      )
        return;
      event.preventDefault();
      strip.hidden = false;
    },
    options,
  );
  panel.addEventListener(
    "dragleave",
    (event) => {
      if (
        !(event.relatedTarget instanceof Node) ||
        !panel.contains(event.relatedTarget)
      )
        reset();
    },
    options,
  );
  panel.addEventListener(
    "drop",
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const isX =
        target?.closest(".xy-drop-strip, .panel-x-axis") !== null &&
        target !== null;
      const isColor = target?.closest(".panel-c-axis") != null;
      reset();
      if (!isX && !isColor) return;
      const choose = isColor ? selectColor : select;
      event.preventDefault();
      event.stopPropagation();
      const current = catalog();
      const data = dragData(event, SIGNAL_DRAG_TYPE);
      let refs: SeriesRef[] =
        data === null
          ? []
          : parseSignalPayload(data).flatMap((path) => {
              const ref = current.refFromPath(path);
              return ref === undefined ? [] : [ref];
            });
      const setData = dragData(event, SET_DRAG_TYPE);
      const set =
        setData === null
          ? undefined
          : sets().find((entry) => entry.id === parseSetPayload(setData));
      if (set !== undefined) {
        const selector = parseSelector(set.selector ?? "");
        refs =
          set.kind === "pick"
            ? set.refs
            : selector.ok
              ? current
                  .allSeries()
                  .filter((series) => seriesMatches(selector.selector, series))
                  .map((series) => ({
                    source_key: series.sourceKey,
                    channel: series.channel,
                  }))
              : [];
      }
      refs = [
        ...new Map(refs.map((ref) => [current.refKey(ref), ref])).values(),
      ];
      if (refs.length === 1)
        choose?.({ kind: "signal", ref: refs[0] as SeriesRef });
      else if (refs.length > 1) choose?.({ kind: "bundle", refs });
    },
    options,
  );
  document.addEventListener("dragend", reset, { signal: abort.signal });
  document.addEventListener("drop", reset, { signal: abort.signal });
  return () => {
    abort.abort();
    strip.remove();
  };
}
