# Bundled Signals and Per-Panel Source Highlights

## Decision

Source bundles are a tree/navigation concept, not a plot type. Plotting a
bundle expands it into ordinary per-source series. Every panel mode (`T`,
`XY`, `FFT`, and `H`) consumes the same series state and data-plane queries.

The ensemble plot pipeline is **deleted, not retained**: the bundle-level
`band`, `spaghetti`, and `single` choices, `PanelState.ensemble`, the
ensemble tile query path, the band renderer, and ensemble snapshot baking
are all removed in this change. Exported snapshot artifacts are
self-contained (they embed their own viewer), so previously exported
snapshots are unaffected; the only compatibility obligation is the session
migration below.

## UI restraint (binding)

The multi-source UI surface stays minimal. This section constrains every
task in the implementation plan:

- **No new panel modes, toolbars, dropdowns, or per-row selects.** The
  existing per-bundle `band | spaghetti | single` `<select>` is deleted and
  not replaced by another control.
- Bundle interactions are exactly three: expand/collapse a bundle row,
  plot (drag, double-click, or Enter), and toggle a member highlight from
  the legend chip or series inspector.
- Everything downstream of "plot" reuses the existing series UI unchanged:
  legend chips, series inspector, visibility/style/remove actions, CSV
  export, zoom/pan/cursor interactions. If a bundle-plotted panel behaves
  differently from a hand-assembled panel with the same series, that is a
  bug.
- No new preferences, no new persisted UI state beyond
  `highlighted_sources` defined below.

## Tree behavior

The signal tree receives signal summaries plus source-set metadata and builds
expandable bundle rows. A bundle is one local signal path shared by multiple
sources in a set. Its row shows the local path and member count; its children
show individual source members.

- Dragging or activating a bundle plots every available member.
- Dragging or activating a child plots only that member.
- Search matches bundle paths and member labels.
- Virtual scrolling and favorites remain leaf-oriented.

Bundle and member drag payloads stay distinct so a panel can handle either
operation without inspecting display labels.

Implementation notes (the current code cannot be extended in place):

- `tree-model.ts` currently returns a _flat, bundle-only_ row list whenever
  set prefixes exist, which makes per-source rows unreachable. That branch
  is replaced wholesale by the expandable bundle/member model above.
- Bundle rows are currently `draggable = false`; they become draggable with
  a distinct payload type.
- Plotting all members of a bundle is **one** workspace mutation (one
  history entry, one layout refresh), not a loop of single-signal plots.

## Panel state and rendering

Bundle members are stored in `PanelState.series` as ordinary `SeriesState`
entries with their complete source-prefixed paths. There is no bundle
object in panel state; the bundle exists only in the tree and, weakly, in
`highlighted_sources`.

Add serialized `highlighted_sources` entries containing `{local_path,
path}`. A panel keeps at most one highlighted member for each local path; a
panel containing multiple bundles may therefore highlight one member in each
bundle.

The series inspector gains a highlight action and the legend marks the active
member. Highlighted members render at normal emphasis while non-highlighted
members that share the highlighted entry's `local_path` are dimmed. Series
whose local path has no highlight entry render at normal emphasis. Hover
emphasis remains transient and takes precedence while the pointer is over a
legend chip. Visibility, style, and remove actions continue to operate on
individual series.

### Bundle-vs-bundle XY (per-source X resolution)

XY plots must support bundle-versus-bundle intrinsically: putting
"temperature" on X while a bundle is on Y means _each source's_ temperature
against _that source's_ Y signal — never one run's temperature shared
across runs.

`x_signal` remains a single full path and no new panel state is added.
When `x_signal` belongs to a source, its **local path is the pairing key**:

- **Setting X from a bundle.** Dropping a bundle on the X-axis strip is
  allowed and stores the bundle's sorted-first member path as `x_signal`.
  Dropping a single member or leaf keeps today's behavior. No other way to
  set X is added.
- **Pairing (exact rules).** Let `xLocal = localPathFor(x_signal)`.
  - `xLocal === null` (derived or unknown X): every Y pairs against
    `x_signal` directly — a shared X.
  - Otherwise, for each visible Y series: if the Y has no source (derived),
    it pairs against `x_signal` directly. If the Y has a source, resolve
    the X series with the **same `source_key`** and local path `xLocal`;
    if that source has no such signal, the trace is **omitted** — two
    different sources are never cross-paired.
- **X chip and axis labels.** When `xLocal` is non-null and the panel's
  visible series span more than one source, the chip **and the rendered X
  axis label** show the local path (the chip tooltip keeps the stored full
  path); otherwise both show the full label as today. A user-set `x_label`
  always wins, as today.
- The sample query for an XY panel requests the union of resolved X paths
  plus Y paths; `renderXy` pairs each Y against its resolved X.

### Per-source color channel

The XY color channel follows the same rules as X. `color_signal` remains a
single full path; setting it from a bundle stores the sorted-first member.
Let `cLocal = localPathFor(color_signal)`:

- `cLocal === null` (derived or unknown): one shared color series for all
  traces, as today.
- Otherwise each sourced trace takes its color values from the signal with
  the **same `source_key`** and local path `cLocal`. A trace whose source
  has no such signal renders **uncolored** (its ordinary series color) —
  color values are never cross-paired between sources. Unsourced (derived)
  traces use `color_signal` directly.
- The color chip and colorbar label show `cLocal` under the same
  multi-source condition as the X labels; a user-set `c_label` wins.
- The XY sample query requests the union of resolved color paths as well.

`FFT` and `H` modes need no pairing rule: each member series is computed
independently, exactly like any other multi-series panel today.

### Drop routing (binding)

Every drop target that accepts a signal drag accepts a bundle drag, and
routing is **exclusive by target** — a drop consumed by a channel target
never falls through to a series add, in any panel mode:

| Target                             | Signal drop                               | Bundle drop                                 |
| ---------------------------------- | ----------------------------------------- | ------------------------------------------- |
| Panel body                         | add series                                | add all members as series                   |
| X-axis strip                       | set `x_signal` (switches to XY, as today) | set `x_signal` to sorted-first member       |
| Color chip                         | set `color_signal`                        | set `color_signal` to sorted-first member   |
| Workspace background / empty state | new panel + plot signal                   | new panel + plot all members                |
| Favorites bar                      | toggle favorite                           | not a target (favorites stay leaf-oriented) |

Channel targets (`X` strip, color chip) must accept both drag types in
`dragover` and stop propagation in both `dragover` and `drop`, so a drag
hovering a chip can never be claimed by the panel body underneath. The
bundle payload parse lives in one shared helper rather than being repeated
per target.

### Data plane

New bundle plots never call ensemble tile queries. Time panels query
ordinary tiles; XY, FFT, and histogram panels query ordinary samples. The
ensemble tile request/response types, the `query_ensemble_tiles` command,
and both planes' `queryEnsembleTiles` ports are deleted.

## Snapshots

Snapshot export stops baking ensembles. `SnapshotManifest.ensembles` and
`BakedEnsemble` are removed from the protocol schema.

`BakedPlane.listSets()` currently reconstructs set metadata _from baked
ensembles_; with baking gone, bundle rows would vanish from snapshot trees.
It is re-sourced instead from data the snapshot already contains:

- set identity, label, and membership from the baked session's
  `source_sets` (`SetMemberState.source_key`),
- member prefixes and availability from the baked `SignalSummary` entries
  (`source_key`, `local_path`, `path`),
- `local_paths` as the local paths shared by at least two available
  members, matching the live plane's bundling rule.

No new baked data is required. `baked-session.ts` drops the `isEnsemble`
validator.

## Schema and migration

**Protocol** bumps 10 → 11: remove `EnsembleBin`, `EnsembleTileRequest`,
`EnsembleTileResponse`, `BakedEnsemble`, and `SnapshotManifest.ensembles`.
There is no cross-version manifest load path (snapshot artifacts embed
their matching viewer), so removal needs no compatibility shim.

**Session** bumps 13 → 14:

- Remove `EnsembleSeriesState` and `PanelState.ensemble`.
- Add `HighlightedSourceState { local_path: string, path: string }` and a
  required `highlighted_sources: HighlightedSourceState[]` on `PanelState`.
- Regenerate Rust and TypeScript outputs; never edit generated files by
  hand.

The v13 → 14 migration rung is a real data transform, not a pass-through:

1. `highlighted_sources` defaults to `[]` on every panel.
2. Each panel with a non-null `ensemble` expands it into member
   `SeriesState` entries: look up the set by `set_key` in
   `session.source_sets`; take its members (restricted to `member_filter`
   when non-empty), sorted by their `SourceRecord.prefix` from
   `session.sources`; skip members whose `missing` contains the ensemble's
   `local_path` or whose source record is absent; each surviving member
   becomes a series with path `prefix + "/" + local_path`, default width
   and dash, `visible: true`, and a deterministically assigned free color
   slot (continue round-robin after the panel's existing series). Members
   already present in `panel.series` are not duplicated. The `ensemble`
   field is then dropped. An unresolvable `set_key` drops the field and
   expands nothing — the panel keeps its explicit series.
3. The migration is a pure JSON transform with no filesystem access, tested
   against a fixture v13 session containing a band panel.

Workspace mutations enforce the one-highlight-per-local-path rule, clear
entries when their series is removed, and preserve the state through session
and snapshot round trips.

## Deletions (binding checklist)

The following are removed entirely; keeping any of it "for later" defeats
the point of this change:

- `core/scope-core/src/ensemble.rs` (whole module) and its `lib.rs` export.
- Ensemble planning in `snapshot.rs` (`plan_ensembles`, `ensemble_window`,
  `ensemble_bin`, `SnapshotPlan.ensembles`, `SnapshotError::Ensemble`, byte
  accounting, and their tests).
- The ensemble benchmark and fixture in `benchmarks.rs`.
- `query_ensemble_tiles` and `DataState.materialized_sets` in the shell.
- `drawEnsembleBand`, `renderEnsemble`, `EnsembleRenderOptions`, and the
  now-orphaned `withAlpha` in `canvas-renderer.ts`.
- `queryEnsembleTiles` on the plane port and both implementations in
  `data-plane.ts`; the ensemble branch of `BakedPlane.listSets`.
- `ensemblesByPanel`, the `plotSet` band/spaghetti/single branches, and the
  ensemble branch of `refreshTiles` in `app-shell.ts`.
- `renderBand`, `lastEnsemble`, `PanelSeriesKind`, and `spaghettiSeries` in
  `panel.ts`; the ensemble plumbing in `workspace-view.ts`.
- The per-bundle mode `<select>` and band activation in `signal-tree.ts`.
- The ensemble types from both protocol schemas (see above) and all
  generated output via `./scripts/codegen.sh`.
- ADR 0028 gains a superseded-by note pointing at this spec; `README.md`
  and `docs/implementation-roadmap.md` drop the band workflow references.

`sets.rs`, set CRUD commands, time alignment, and `SetSummary` stay: they
serve tree bundling, restore, and snapshot planning, not just ensembles.

## Validation

- Tree-model and tree-view tests cover bundle expansion, bundle/member
  activation, search, drag payloads, and that per-source leaf rows remain
  reachable when sets exist.
- Workspace tests cover single-mutation bundle plots, replacement and
  cleanup of per-bundle highlights, and the no-duplicate rule.
- Renderer tests cover multiple emphasis indices and mixed highlighted and
  unhighlighted members.
- Panel/data-plane tests cover a two-source bundle in `T`, `XY`, `FFT`, and
  `H`, ensuring ordinary tile/sample requests are used, and that XY pairs
  each member against its own source's X. Bundle-vs-bundle XY tests cover:
  dropping a bundle on the X strip sets `x_signal` to the sorted-first
  member; a source lacking the X local path has its trace omitted, never
  cross-paired; derived X or derived Y pairs against `x_signal` directly;
  the chip shows the local path when visible series span multiple sources.
- Drop-routing tests cover every row of the routing table for both drag
  types: bundle to workspace background creates one panel with all members;
  bundle to the color chip sets `color_signal` without adding series in any
  panel mode; per-source color pairing, the uncolored-trace rule, and
  local-path X/color axis labels.
- Session tests cover the v13 → 14 rung: band panel expands to sorted
  member series, `member_filter` respected, missing members skipped,
  duplicates avoided, unresolvable `set_key` degrades gracefully.
- Snapshot tests cover `listSets` derived from the baked session (bundle
  rows survive without baked ensembles) and serialized highlights.
- Playwright covers the end-to-end bundle selection flow.
- Grep gates: `ensemble` appears nowhere in `frontend/src`, `shell/`, or
  `core/scope-core/src` outside the session migration rung and its fixture;
  `spaghetti` and `PanelSeriesKind` appear nowhere.
