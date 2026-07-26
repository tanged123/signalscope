import type { PanelMode } from "../generated/session";
import type { AnnotationSpace } from "../render/overlay-renderer";

/**
 * What each panel mode can do.
 *
 * These rules were previously spelled out as `mode === …` comparisons spread
 * across the panel view and the shell. A new mode had to be hunted down at
 * every site, and the negative forms (`mode !== "time"`) captured it silently
 * with the wrong behaviour. One row per mode instead, so adding a mode is a
 * compile error until every capability is answered.
 */
export interface ModeTraits {
  /** Envelope tiles, or decimated window samples (ADR 0015). */
  source: "tiles" | "samples";
  /** The x axis is the shared time window rather than a panel-local range. */
  xIsTime: boolean;
  /**
   * The plot accepts zoom and pan gestures. Histogram is excluded: its x axis
   * is a value axis whose bin edges are recomputed from the visible window,
   * so panning it would be misleading (ADR 0018).
   */
  interactive: boolean;
  /** Annotations can be pinned, drawn, and listed. */
  annotations: boolean;
  /** Coordinates the overlay places annotations in. */
  annotationSpace: AnnotationSpace;
  /** The stats strip applies. */
  stats: boolean;
  /** The linked cursor drives this panel; other modes own a local cursor. */
  globalCursor: boolean;
  /** The cursor draws as a vertical line rather than trajectory markers. */
  verticalCursor: boolean;
  /** The header carries the "window: visible t" note. */
  windowNote: boolean;
}

export const MODE_TRAITS: Record<PanelMode, ModeTraits> = {
  time: {
    source: "tiles",
    xIsTime: true,
    interactive: true,
    annotations: true,
    annotationSpace: "time",
    stats: true,
    globalCursor: true,
    verticalCursor: true,
    windowNote: false,
  },
  xy: {
    source: "samples",
    xIsTime: false,
    interactive: true,
    annotations: true,
    annotationSpace: "plot",
    stats: false,
    globalCursor: true,
    verticalCursor: false,
    windowNote: false,
  },
  fft: {
    source: "samples",
    xIsTime: false,
    interactive: true,
    annotations: false,
    annotationSpace: "plot",
    stats: false,
    globalCursor: false,
    verticalCursor: true,
    windowNote: true,
  },
  histogram: {
    source: "samples",
    xIsTime: false,
    interactive: false,
    annotations: false,
    annotationSpace: "plot",
    stats: false,
    globalCursor: false,
    verticalCursor: true,
    windowNote: true,
  },
};

/** Traits for a possibly-absent mode; falls back to `time`. */
export function traits(mode: PanelMode | undefined): ModeTraits {
  return MODE_TRAITS[mode ?? "time"];
}
