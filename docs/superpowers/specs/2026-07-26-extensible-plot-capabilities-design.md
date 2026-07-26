# Extensible Plot Capabilities Design

**Status:** Approved direction

**Date:** 2026-07-26

## Goal

Make cursor inspection, annotations, statistics, deltas, and interaction
policies native to every current plot mode, while making omission of those
features difficult when a future plot mode is added.

This design replaces scattered mode checks and capability booleans with a
prepared plot-mode adapter. The adapter owns the transformed data that was
actually drawn and supplies every standard inspection capability from that
same data.

## Product Decisions

- Annotations remain owned and serialized by their panel.
- Time and XY share timestamp-anchored annotations.
- FFT annotations are frequency-anchored and retained when the panel changes
  mode.
- Histogram annotations are source-value-anchored and retained when the panel
  changes mode.
- Switching modes never clears annotations. Returning to a mode restores its
  annotation set.
- FFT and histogram annotations re-resolve against the current transformed
  data when the linked time window changes.
- Statistics are domain-native rather than mechanically applying time-series
  labels to every curve.
- Cursors remain timestamp-linked between time and XY. FFT and histogram
  cursors remain panel-local because frequency and source value are not time.

## Current Problem

`PanelView` currently renders each mode itself, while `MODE_TRAITS` describes
features with booleans such as `annotations` and `stats`. Cursor, hit-testing,
annotation resolution, delta formatting, and statistics are implemented in
separate mode branches. This permits a mode to render correctly while silently
opting out of standard plot behavior.

The persisted `Annotation` type also assumes that every annotation is a
`{time, value}` pair. Reusing `time` for frequency or histogram values would
make sessions ambiguous and would leak derived-domain values into linked-time
behavior.

## Architecture

### Plot mode adapter

Every `PanelMode` has one `PlotModeAdapter`. It consumes the appropriate
bounded query result and prepares a `PreparedPlot`:

```ts
interface PlotModeAdapter {
  readonly mode: PanelMode;
  prepare(input: PlotPreparationInput): PreparedPlot;
}

export interface PreparedPlot {
  readonly mode: PanelMode;
  readonly domain: AnnotationDomain;
  readonly frame: PlotFrame;
  readonly interaction: PlotInteractionPolicy;

  cursorAt(
    layout: PlotLayout,
    point: PlotPoint,
    radius: number,
  ): PlotCursor | null;
  annotationAt(
    layout: PlotLayout,
    point: PlotPoint,
    radius: number,
  ): AnnotationAnchor | null;
  resolveAnnotation(annotation: Annotation): ResolvedAnnotation | null;
  stats(): readonly PlotStatGroup[];
  delta(resolved: readonly ResolvedAnnotation[]): PlotDelta | null;
}
```

`PlotFrame` is the renderer input: paths or envelope tiles, axis ranges,
labels, styles, and optional colorbar. `PreparedPlot` retains only the bounded
arrays needed to inspect that frame. It never fetches data and never branches
on `DataPlane` host identity.

The adapters are registered exhaustively:

```ts
const PLOT_MODES: Record<PanelMode, PlotModeAdapter> = {
  time: timeMode,
  xy: xyMode,
  fft: fftMode,
  histogram: histogramMode,
};
```

Adding a `PanelMode` therefore fails typechecking until it has a complete
adapter. There are no `annotations: false` or `stats: false` escape hatches.
An empty plot still returns a prepared object whose inspection methods return
`null` or empty rows.

### Responsibility boundaries

- Pure mode modules prepare frames and implement inspection math.
- `PanelView` owns DOM events, canvases, and transient pointer state. It asks
  the prepared plot for cursor hits, annotation hits, statistics, and deltas.
- `CanvasRenderer` draws `PlotFrame`.
- `OverlayRenderer` draws already-resolved cursors, annotations, and deltas.
  It does not infer domain semantics from session fields.
- `WorkspaceModel` owns persisted annotations and mode-independent panel
  state.
- `AppShell` formats generic capability output into the status bar, tooltip,
  and statistics strip without checking the active mode.

This keeps transformation and domain semantics out of UI chrome while
preserving one presentation plane for native and snapshot hosts.

## Domain Model

### Cursors

```ts
interface PlotCursor {
  domain: AnnotationDomain;
  x: number;
  heading: PlotReading;
  rows: readonly PlotReadingRow[];
  markers: readonly PlotMarker[];
  link: "time" | "local";
}
```

- Time returns a time cursor with one value per visible series.
- XY resolves the nearest trajectory point and returns its timestamp plus X,
  every visible Y, and optional color-channel values.
- FFT returns frequency plus interpolated dB amplitude for every visible
  spectrum.
- Histogram returns the containing bin interval plus each visible series'
  sample count.

Only cursors with `link: "time"` update `LinkedTimeModel`.

### Persisted annotations

Session schema v6 replaces the time-specific annotation coordinates with:

```text
AnnotationDomain = time | frequency | distribution

Annotation {
  id: string
  series_path: string
  domain: AnnotationDomain
  anchor: f64
  pinned_value: f64
  label: string
}
```

`anchor` is timestamp seconds, frequency Hz, or source value according to
`domain`. `pinned_value` records what the user selected for stable session
round-tripping and migration; rendering and current readouts use the resolved
value from `PreparedPlot`. If the current frame cannot resolve an annotation,
the annotation remains serialized and its list row says `unavailable`.

The panel keeps one annotation array partitioned by `domain`. These are
separate logical sets without a schema field per mode, so a future mode can
reuse an existing domain or add one through a normal schema migration.
Time and XY both select the `time` partition. FFT selects `frequency`.
Histogram selects `distribution`.

The v5-to-v6 migration maps:

```text
time         -> anchor
value        -> pinned_value
domain       -> time
```

All older versions continue through the existing migration ladder. Unknown
future versions continue to fail clearly.

### Annotation resolution

- Time: locate the annotated series at the timestamp.
- XY: use the timestamp to resolve X, the selected Y series, and optional C.
- FFT: interpolate the selected spectrum at the anchored frequency.
- Histogram: find the bin containing the anchored source value and read the
  selected series' count.

Annotations outside the current frame, missing a visible series, or lacking
finite transformed data resolve to `null`; they are not deleted.

Pinning and removal use the prepared plot's plot-space marker positions.
Keyboard removal and annotation-list editing continue to operate on IDs.

### Domain-native deltas

The prepared plot formats the last two resolved annotations in the active
domain:

- Time: `Δt`, `Δy`, and `Δy/Δt`.
- XY: `Δt`, `Δx`, `Δy`, and optional `Δc`.
- FFT: `Δf` and `ΔdB`.
- Histogram: `Δvalue` and `Δcount`.

A delta is omitted when fewer than two annotations resolve. Cross-series
deltas remain allowed and identify both series in the annotation list; slope
is shown only where its domain definition is unambiguous.

## Domain-Native Statistics

Adapters return generic labeled groups:

```ts
interface PlotStatGroup {
  key: string;
  label: string;
  colorIndex: number | null;
  items: readonly PlotStat[];
}

interface PlotStat {
  label: string;
  value: number | null;
  unit: string | null;
}
```

The panel stats strip renders these groups without mode checks.

- Time: per visible series `min`, `max`, `mean`, `rms`, and `n` over the
  visible time window.
- XY: one shared X group and one group per visible Y trajectory over the
  illuminated time window, each with `min`, `max`, `mean`, `rms`, and `n`;
  an assigned color channel adds its finite `min` and `max`.
- FFT: per visible spectrum `peak f`, `peak amplitude`, visible frequency
  span, and visible bin count.
- Histogram: per source series `min`, `max`, `mean`, `rms`, and `n` over the
  visible time window, plus the shared histogram bin count.

Statistics use the same bounded tiles or sample response used to prepare the
plot. The UI says `visible region` and does not claim raw-source exactness
when ADR 0015 sampling has applied.

## Interaction Policy

`PlotInteractionPolicy` replaces the remaining interaction booleans:

```ts
interface PlotInteractionPolicy {
  xAxis: "linked-time" | "local";
  cursorLink: "time" | "local";
  pan: ReadonlySet<"x" | "y">;
  zoom: ReadonlySet<"x" | "y" | "box">;
  fit: boolean;
  windowNote: string | null;
}
```

The input controller consumes this policy generically. A future mode must
declare its axis and gesture behavior as part of its adapter rather than being
captured accidentally by a negative mode check.

## Data and Performance

- Time inspection continues to use density-bounded envelope tiles.
- XY, FFT, and histogram continue to use ADR 0015's capped sample response.
- FFT and histogram cache their transformed arrays in `PreparedPlot`; cursor,
  annotation, delta, and stats operations do not recompute transforms.
- Pointer movement performs interpolation or bin lookup only and does not
  allocate full transformed arrays.
- No runtime dependency is added.

## Empty, Missing, and Changing Data

- Empty adapters render the existing factual empty state.
- Cursor and pin attempts return `null`.
- Stats return no groups.
- Saved annotations remain listed as unavailable.
- Removing a source series removes annotations for that series from every
  domain, preserving the existing pruning rule.
- Changing the linked time window prepares a new plot and re-resolves derived
  annotations. It never mutates their anchors.

## Testing

Pure TypeScript tests cover each adapter:

- cursor domain, rows, markers, and link policy;
- annotation pinning and resolution;
- annotation retention when transformed data changes;
- domain-native deltas;
- domain-native statistic groups;
- empty and non-finite input.

Session tests cover v5-to-v6 migration, current-version round trips, unknown
future-version rejection, and generated-output synchronization.

Playwright covers:

- pin, edit, remove, and restore after mode switching in all four modes;
- FFT and histogram annotation movement after the linked time window changes;
- domain-native delta labels;
- domain-native stats with the global and per-panel toggles;
- cursor linking for time/XY and cursor locality for FFT/histogram;
- tooltip dismissal and cursor-off behavior.

The full repository gate remains `./scripts/ci.sh all`.

## Documentation

ADR 0005 is amended for schema v6 migration. ADRs 0017 and 0018 are amended
with derived-domain annotation and statistics semantics. The Phase 2B plan is
historical and is not rewritten.
