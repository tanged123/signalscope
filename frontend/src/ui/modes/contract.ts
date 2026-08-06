import type { ColumnarTileResponse } from "../../app/bin-columns";
import type { PreparedPlot } from "../../app/plot-capabilities";
import type { Range } from "../../app/plot-math";
import type { SeriesPathCallbacks, XyTrace } from "../../app/xy";
import type { SampleResponse } from "../../generated/protocol";
import type { DashStyle, PanelMode } from "../../generated/session";
import type {
  PathRenderOptions,
  PlotPath,
  RenderOptions,
} from "../../render/canvas-renderer";
import type { RenderPanelState } from "../panel";

/**
 * What a mode needs fetched — the spec's stage 1 declaration. The shell owns
 * padding, budgets, caching, and request plumbing; a mode only states its
 * reduction semantics and which sample windows it consumes. Envelope modes
 * ride the tile pipeline and declare no sample windows.
 */
export interface ModeDataSpec {
  reduction: "envelope" | "samples";
  windows: readonly ("visible" | "context")[];
}

export const MODE_DATA: Record<PanelMode, ModeDataSpec> = {
  time: { reduction: "envelope", windows: [] },
  xy: { reduction: "samples", windows: ["context", "visible"] },
  fft: { reduction: "samples", windows: ["visible"] },
  histogram: { reduction: "samples", windows: ["visible"] },
};

/**
 * Stage-2 input: everything that changes only when data or panel
 * configuration lands. Deliberately excludes the visible window — prepare
 * output must be reusable across every pan/zoom frame.
 */
export interface PrepareInput {
  state: RenderPanelState;
  tiles: ColumnarTileResponse | null;
  samples: SampleResponse | null;
  callbacks: SeriesPathCallbacks;
}

/** Stage-3 input: the per-frame view state. */
export interface FrameInput {
  window: { t0: number; t1: number };
  emphasizePaths: ReadonlySet<string> | null;
  /**
   * Resolves final axis ranges from a prepared plot — wraps the panel's
   * sticky y-axis policy, which is per-panel mutable state and therefore
   * stays outside the pure module.
   */
  resolveRanges(
    prepared: PreparedPlot,
    seriesKey?: string,
  ): { x: Range; y: Range } | null;
}

/** What stage 3 hands the renderer — one of the two existing entry points. */
export type ProjectedPlot =
  | { kind: "empty" }
  | {
      kind: "bins";
      response: ColumnarTileResponse;
      xRange: Range;
      options: RenderOptions;
    }
  | { kind: "paths"; paths: PlotPath[]; options: PathRenderOptions };

/** The XY trace entry PanelView keeps for hit-testing and cursor markers. */
export interface XyTraceEntry {
  path: string;
  colorIndex: number;
  hue: number | null;
  dash: DashStyle;
  width: number;
  opacity: number;
  trace: XyTrace;
}

/** The FFT domain-series entry PanelView keeps for cursor readouts. */
export interface DomainSeriesEntry {
  path: string;
  colorIndex: number;
  hue: number | null;
  opacity: number;
  x: number[];
  y: number[];
}

export interface ProjectResult {
  plot: ProjectedPlot;
  prepared: PreparedPlot | null;
  /** Side-band state the panel chrome consumes; assigned when present. */
  xyTraces?: XyTraceEntry[];
  domainSeries?: DomainSeriesEntry[];
  hasColorbar?: boolean;
  /** Drives the panel's mode empty-state message (fft and histogram). */
  emptyState?: { empty: boolean; note: string };
}

/**
 * One plot mode. `prepare` is response-scoped and pure — the framework
 * caches its result on (tiles, samples, configKey) identity, so it never
 * runs during pan/zoom. `project` is frame-scoped and must stay cheap; it
 * is the only per-frame mode code.
 */
export interface PlotModeModule<Geometry = unknown> {
  readonly mode: PanelMode;
  readonly data: ModeDataSpec;
  configKey(state: RenderPanelState): string;
  prepare(input: PrepareInput): Geometry;
  project(
    geometry: Geometry,
    input: PrepareInput,
    frame: FrameInput,
  ): ProjectResult;
}
