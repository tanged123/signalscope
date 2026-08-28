# Implementation roadmap after Phase 0

## Phase 1 — workbench fundamentals

Complete native file dialogs, persisted pyramid sidecars, progress reporting, MCAP ingest, virtualized signal search/favorites, panel lifecycle, seam resizing, drag rearrangement, and keyboard-equivalent commands.

## Phase 2 — scientific interaction

Finish linked desktop gestures, gutter/inline axes, editable labels, split
legend inspector, visible statistics, annotations and delta readouts, and
time-series export fidelity.

## Phase 3 — transforms and durable sessions

Ship the docked expression bar with history, full prototype-compatible expression semantics, derived signals in the tree, schema migrations, autosave/recovery, and snapshot/session round-trip coverage.

Phase 3 shipped a MATLAB-dialect expression language evaluated in
`scope-core::expr` ([ADR 0008](adr/0008-expression-evaluation-layer.md)
amendment): quoted names are signal references, functions are bare MATLAB
names, and the transforms are `gradient`/`cumtrapz`/`movmean`. Derived signals
materialize into the store under one synthetic source with an in-memory
pyramid, so every tile, sample, and panel-mode consumer is unchanged. Sessions
reached schema v19 with ordered derived definitions, durable source records,
source-local channel-by-source panel bindings, and named sets,
and gained autosave with resume-on-launch plus named workspace files
([ADR 0022](adr/0022-durable-session-persistence.md)). The `localStorage` theme
key is gone; the session is the only durable store.

Protocol v14 and session v19 remove source alignment metadata that was never
applied to tile or sample queries; v18 sessions migrate by dropping those
fields while preserving source identity and provenance
([ADR 0031](adr/0031-remove-source-alignment.md)).

Multi-source ingest now uses batch jobs with per-file outcomes,
memory-weighted admission, streaming CSV decode, and off-lock pyramid
construction ([ADR 0026](adr/0026-batch-ingest-and-off-lock-decode.md)).
Durable source keys separate storage identity from display prefixes; legacy
sessions reconcile provider-specific references after restore while autosave
is paused
([ADR 0027](adr/0027-durable-source-identity-and-restore-reconciliation.md)).

Format dispatch now uses a deterministic runtime provider registry with a
bounded content probe and fail-closed unknown-input handling
([ADR 0033](adr/0033-format-provider-registry.md)). Native format pickers,
folder scans, and drag-drop acceptance derive from the same provider metadata.

Declarative container recipes now cover HDF5 and Parquet. Native
readers expose bounded dataset outlines, recipes resolve from source sidecars
before the user recipe directory, and session schema v20 records the recipe
id and content digest used for each source ([ADR 0034](adr/0034-declarative-container-recipes.md)).

Signals-at-scale P1 is landed: panels resolve channel-by-source series from a
catalog, source identity is stored per source, and the tree exposes channels
with read-only named sets instead of source sets, bundle rows, or favorites.
Shared channel collections still use the derived-bundle evaluator: dropping or
typing a shared channel in the formula bar materializes one ordinary derived
member per eligible source.

Out-of-core storage now compacts pyramid bins, synthesizes levels 0–2, shares
sidecar time sections, and pages columns and fine levels through a leased LRU.
Derived columns spill under resident pressure.

## Phase 4 — export and fidelity

Implement the export size-budget model, visible/all-loaded tile selection, PNG and visible CSV exports, renderer screenshot matrices across themes and axes, and deterministic snapshot parity checks. The release-generated README GIF and hosted live demo now ship from the export path per the [automated demo artifacts plan](superpowers/plans/2026-07-30-automated-demo-artifacts.md).

The HTML export picker lists each source once, independent of its signal
count. Its source list and dialog body remain bounded and scroll internally so
large campaigns cannot push export controls outside the viewport.

## Phase 5 — performance and hardening

Benchmark cold multi-GB first plot, cache build and reuse, tile latency, 100M-point pan/zoom, NaN gaps, corrupt inputs, accessibility invariants, release bundles, and artifact-size regression thresholds.

The benchmark track landed ([ADR 0035](adr/0035-benchmark-harness-and-performance-floors.md)) with deterministic corpus tiers, core performance floors, a Playwright bench project, a weekly workflow, and the `./scripts/test.sh bench` entry point.

Parquet is included when it does not delay MCAP and the core interaction path. Live streaming, layout-preset UI, Monte Carlo envelope ergonomics, 3D, and `scope-serverd` remain v2.

The July 2026 UI audit pass replaced the global toolbar with three permanent
strips: title, workspace tabs, and status. The hidden `≡` application menu and
the split signal/command palettes now mirror one registry. File persistence,
HTML/PNG/CSV export, and layout-preset entries remain visible planned stubs;
their backing behavior continues in Phases 3–4 rather than being implied by
inert chrome.

Signals-at-scale P2 is landed: the selector grammar, named-set UX, and palette
unification now cover dock filters, bindings, saved sets, and signal search.

Signals-at-scale P3 is landed: panel style resolution now maps color rules and
selector overrides into explicit focus, rule, and ghost strokes. Matrix legend
rosters, grouped binding chips, focus/ghost controls, plot hit navigation, and
grouped cursor readouts keep large multi-source panels bounded while preserving
keyboard access and session round-trips.

Signals-at-scale P4 is landed: the signals dock now provides a virtualized,
sortable selector-filtered table with series/channel granularity, shared
tree/table multi-selection, and bulk add, style, hide, save-set, and derive
actions without requesting sample data.

Signals-at-scale P5 is landed: channel identity now has a workspace-scoped,
non-destructive map with near-match suggestions, merge/keep-separate actions,
original-name recovery, unit-conflict flags, and a bounded channel-map view;
time panels can facet by source or channel with linked-y small multiples and a
16-cell overflow guard. Tooltip row expansion and facet annotations remain
follow-ups because annotations stay attached to the unsplit plot in this
phase.

The plotting performance overhaul ([implementation plan](superpowers/plans/2026-08-04-plotting-performance-overhaul.md)) now reports a 6.0 s mc1000 first plot for 1,000 inputs; core tile p95 is 14.2 ms cold and 14.6 ms warm. Browser frame p95 remains 66.5 ms and the longest stall 2.1 s on the benchmark runner, so both still exceed their 33 ms and 250 ms budgets.

The August 2026 ChartGPU work replaced the Tauri shell with the loopback
`scope-server` HTTP host ([ADR 0038](adr/0038-browser-only-host.md)) and moved
time-series rendering to a pinned, vendored WebGPU renderer
([ADR 0039](adr/0039-chartgpu-time-series-renderer.md)). The Phase 0 spike
measured a 470 ms first frame, 8 ms frame p95, and 33 ms full-thousand-series
refeed; PNG capture uses the same-frame composite recipe proven by the spike.
The presentation plane is now time-only and ChartGPU is the single plotter;
the former XY, spectrum, and histogram paths were withdrawn in
[ADR 0043](adr/0043-time-only-presentation.md).

Adaptive-resolution presentation ([ADR 0044](adr/0044-adaptive-resolution-presentation.md), refined by [ADR 0045](adr/0045-budgeted-persistent-presentation.md)) now assigns one uniform bins-per-physical-pixel density to the active layout. Prepared CPU and GPU overview/detail banks remain resident when managed byte budgets allow; inactive banks are evicted before active density is reduced, and current, stale, and missing states keep an existing drawable response visible while panel-wide replacements are fetched and prewarmed. There is no fixed series-count ceiling. WebGPU loss is explicit and recoverable through reload, while the managed status does not claim total or free VRAM. `HttpPlane` and baked snapshots retain the same host-neutral contract, and explicit export fidelity remains governed by ADRs 0024 and 0025. ADR 0041's full-resolution baseline remains the zoom endpoint rather than the overview transfer policy.

The first measured follow-up landed as
[ADR 0042](adr/0042-padded-render-feed.md): the renderer consumes the padded
tile response so an in-pad pan reuses resident vertices instead of rebuilding
them, and presentation math bounds itself by the visible window. Compact
raw-sample binary transport and eventual pyramid removal remain open.

The channel map and facet splitting were subsequently removed. Channel
identity is source-local, named sets cover reusable grouping, and schema v18
migrates explicit mapped references before deleting the map
([ADR 0030](adr/0030-source-local-channel-identity.md)).

Phase 1 visualization foundations closed with a validated categorical palette
that reserves amber ([ADR 0011](adr/0011-series-palette-and-reserved-amber.md)),
a headless renderer harness and coherent tick pipeline, unbounded series
allocation with composite colour/dash identity, and stable per-panel y axes
resolved outside the renderer.

Phase 2 desktop interaction (2A) shipped: linked wheel/box/pan/fit gestures
with per-panel unlinked windows, aspect-ratio snapping from box zoom to
single-axis zoom, both-axis pointer-centered wheel zoom, and selectable
off/dot/line cursor modes (default off; dots track visible series; the tooltip
is attached to line mode). Pinned annotations have delta readouts, and a
visible-region statistics
strip backed by envelope-bin sums
([ADR 0014](adr/0014-envelope-bin-sums.md)), gutter/inline axis styles,
in-place title and axis-name editing, a visible per-panel axis-style control,
Favorites star/drop affordances, and the split legend inspector. Series
strokes are clipped to the plot rectangle, tile queries retain neighboring
edge bins for continuous clipped strokes, and level-zero cursor values
interpolate between rendered samples.
The categorical series order now uses MATLAB's canonical seven defaults, with
the eighth slot rolling over to dashed blue; amber remains reserved by token
and semantic role rather than by banning MATLAB yellow.

Phase 2B closed the time-series interaction work: linked windows, cursor
readouts, annotations, deltas, and the gesture set are presentation-plane
behavior over the tile response. The former XY, spectrum, and histogram
experiments were withdrawn with the implementation in
[ADR 0043](adr/0043-time-only-presentation.md); their accepted records remain
historical context for a future reintroduction.

The prototype's `1:1` equal-axis control was dropped for want of a home in the
final chrome. Reintroducing XY is deferred until the sample path has binary
columnar transport and two-dimensional per-vertex colour mapping has either a
scoped ChartGPU fork or a binned-segment approximation; ADR 0043 records both
constraints.
