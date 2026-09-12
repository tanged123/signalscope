import type {
  PanelContent,
  AnnotationDisplay,
  DashStyle,
  FocusEntry,
  LegendAnchor,
  LegendDock,
  LegendState,
  NamedSet,
  PanelState,
  SeriesRef,
  StyleDimension,
  StatColumn,
  SampleAxisSource,
} from "../generated/session";
import type { Catalog } from "../app/catalog";
import type { ResolvedSeries } from "../app/resolution";
import type { PanelSeriesAction } from "../app/panel-series-actions";
import type { AnnotationAnchor, PlotCursor } from "../app/plot-capabilities";
import type { AxisLimits } from "./axis-limits";
type PanelCursor = PlotCursor;
export type EncodingProperty = "color" | "dash" | "width";

export interface PanelCallbacks {
  onFocus(id: string): void;
  onClose(id: string): void;
  onSplitLeft?(id: string, content?: PanelContent): void;
  onMinimize?(id: string): void;
  onSplitRight(id: string, content?: PanelContent): void;
  onSplitDown(id: string, content?: PanelContent): void;
  onMaximize(id: string): void;
  onDropSignals(id: string, paths: string[]): void;
  onDropSet(id: string, setId: string): void;
  onFocusToggle(id: string, entry: FocusEntry): void;
  onFocusAdd(id: string, entry: FocusEntry): void;
  onFocusRange(id: string, entries: readonly FocusEntry[]): void;
  onClearFocus(id: string): void;
  onSeriesAction(id: string, action: PanelSeriesAction): void;
  onMuteSelector(id: string, selector: string): void;
  onMuteSeries(id: string, ref: SeriesRef): void;
  onRemoveBinding(id: string, index: number): void;
  onToggleGhostMode(id: string): void;
  onLegendLayout(
    id: string,
    layout: {
      state?: LegendState;
      position?: [number, number] | null;
      size?: [number, number] | null;
      anchor?: LegendAnchor | null;
      dock?: LegendDock | null;
      hintDismissed?: boolean;
    },
  ): void;
  localPathFor(path: string): string | null;
  sourceKeyFor(path: string): string | null;
  pathForRef(ref: { source_key: string; channel: string }): string | null;
  catalog(): Catalog;
  namedSets(): readonly NamedSet[];
  resolveSeries(state: PanelState): readonly ResolvedSeries[];
  onToggleSeries(id: string, ref: SeriesRef): void;
  onResized(id: string): void;
  onGesture(id: string, hint: string | null): void;
  onCursor(
    id: string,
    cursor: PanelCursor | null,
    client: { x: number; y: number } | null,
  ): void;
  onTimeWindow(id: string, t0: number, t1: number): void;
  onYRange(id: string, range: readonly [number, number]): void;
  onXRange(id: string, range: readonly [number, number]): void;
  onSetAxisLimits?(id: string, limits: AxisLimits): void;
  onPinAnnotation(id: string, hit: AnnotationAnchor): void;
  onRemoveAnnotation(id: string, annotationId: string): void;
  onClearAnnotations?(id: string): void;
  onSetAnnotationDisplay?(id: string, display: AnnotationDisplay): void;
  onSetAnnotationOffset?(
    id: string,
    annotationId: string,
    offset: readonly [number, number],
  ): void;
  onEditAnnotationLabel(id: string, annotationId: string, label: string): void;
  onFitView(id: string): void;
  onToggleStats(id: string): void;
  onToggleAxisStyle(id: string): void;
  onRenameTitle(id: string, title: string): void;
  onEditAxisLabel(id: string, axis: "x" | "y", label: string | null): void;
  onSetEncoding(
    id: string,
    property: EncodingProperty,
    dimension: StyleDimension | null,
  ): void;
  onSetPanelLineWidth(id: string, width: number): void;
  onSetGhostOpacity(id: string, opacity: number): void;
  onSetStatColumns(id: string, columns: StatColumn[]): void;
  onSetStatsSort(
    id: string,
    column: StatColumn | null,
    descending: boolean,
  ): void;
  onRevertStyleOverride(id: string, index: number): void;
  onClearOverrides(id: string): void;
  onPatchSeriesStyle(
    id: string,
    ref: SeriesRef,
    style: {
      color_slot?: number | null;
      dash?: DashStyle | null;
      width?: number | null;
    },
  ): void;
  onRemoveSeries(id: string, ref: SeriesRef): void;
  onSetXAxis?(id: string, xAxis: SampleAxisSource): void;
  onSetColorAxis?(id: string, axis: PanelState["color_axis"]): void;
}

export interface RenderSeries {
  ref: SeriesRef;
  path: string;
  display: ResolvedSeries["display"];
  hue: number | null;
  dash: DashStyle;
  width: number;
  opacity: number;
  visible: boolean;
  focused: boolean;
  overridden: boolean;
  overrideFields: { color: boolean; dash: boolean; width: boolean };
}

export type RenderPanelState = PanelState & {
  series: RenderSeries[];
};
