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
- Virtual scrolling remains row-oriented; favorites accept leaves **and
  bundles** (see "Bundle favorites").

Bundle and member drag payloads stay distinct so a panel can handle either
operation without inspecting display labels.

### Scale rules (hundreds of sources)

The signals list grows with distinct local paths, not with source count —
that is the point of bundles — but three rules keep it usable at hundreds
of sources:

- **Bundles are keyed per set** — `(set, local_path)`, never merged across
  sets. When exactly one set exists, rendering is unchanged from today.
  When more than one set exists, each set contributes a collapsible
  depth-0 header row (its `SetSummary.label`; ordinary group-row
  affordance, no new control) with its bundles nested beneath.
- **Bundle local paths join the segment hierarchy.** Nested local paths
  (`imu/accel/x`) produce the same collapsible group rows as the plain
  tree, with the bundle row as the leaf (its label is the final segment,
  badge unchanged). A flat list of full local paths is only acceptable
  because it falls out of single-segment paths, not as the general shape.
  Group and set collapse keys are namespaced (`set:<key>`,
  `<set_key>//<group_path>`) so they can never collide with source-prefix
  group keys in the non-bundled tree.
- **The sources footer collapses.** The per-source rows
  (`run_01.csv · 3,003 pts`) are replaced by a one-line summary
  (`N sources · M pts`) that expands on demand; the expanded list is
  virtualized with the same `virtualSlice` machinery as the tree and is
  collapsed by default when there are more than 8 sources.

Member expansion needs no cap: rows are virtualized, so a 300-member
bundle is cheap.

### Derived rows and reserved prefixes (deconfliction)

`derived/` is a **reserved prefix that never creates a group row**,
anywhere in the tree — neither in the bundle segment hierarchy nor in the
plain (non-bundled) tree. Derived rows render at top level of their
section, labeled by their name, with the ƒx mark carrying the
derived-ness; they sort by that label among their siblings:

- A derived bundle (`derived/<name>` shared across sources) is a
  top-level bundle row labeled `<name>` with the ƒx mark and its remove
  control — never nested under a `derived` group. Its only expansion is
  member expansion.
- An unsourced derived leaf (`derived/<name>`) is a top-level leaf
  labeled `<name>` with the ƒx mark, likewise ungrouped.
- Derived bundle names are **single segments** (no `/`), enforced at
  creation, so `derived/<name>` is always exactly two segments and the
  flat rendering has no residue.
- Rationale: a group row must communicate tree structure. A permanent
  one-child-kind group under a reserved segment communicates nothing the
  ƒx mark doesn't, and stacking group expansion on top of bundle
  expansion made two unrelated caret affordances look like one.

### Bundle favorites

Favorites accept whole bundles. A bundle favorite is a **local path** —
it re-resolves against the currently loaded sets every render, which keeps
it meaningful across sessions and campaigns:

- The bundle row gets the same star affordance as leaves. Starring stores
  the local path in a new `favorite_bundles: string[]` (session v15);
  leaf favorites in `favorites` are unchanged.
- The favorites bar renders a bundle chip with the local path and a run
  count. Activating or dragging it plots the union of current members
  across all sets containing that local path; with zero current members
  the chip renders muted and inert rather than erroring.
- Bundle favorites survive session and snapshot round trips like leaf
  favorites.

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

### Derived bundles

Derived signals gain bundle semantics without new expression-language
syntax: a quoted reference in an expression resolves first as a full
signal path (today's behavior), and otherwise as a **bundle local path**.

- An expression containing at least one bundle reference defines a
  **derived bundle** named `derived/<name>`. For every source that has
  **all** of the expression's bundle-referenced local paths (the
  intersection — this is the partial-bundle rule below), the bundle
  references are rewritten by token span to that source's full paths and
  the expression is evaluated with the existing engine. Each result
  registers under that source with local path `derived/<name>` and
  display path `<prefix>/derived/<name>`.
- Because members are ordinary per-source signals sharing a local path,
  everything downstream works with **zero new code paths**: the tree shows
  a `derived/<name>` bundle (with the ƒx mark), highlights, XY/color
  per-source pairing, favorites, export, and snapshots all apply
  unchanged. Referencing `'derived/<name>'` in another expression
  composes for free — it is just another bundle local path.
- Full-path references mixed into a bundle expression bind the same
  signal for every member (e.g. `'temperature' - 'run_01/temperature'`
  plots each run's deviation from run 1).
- Membership is **dynamic**: derived bundles re-expand when set
  membership changes (after batch ingest or restore); newly loaded
  sources gain members, and removing a source removes its member.
- Creation reports partiality instead of failing: "created for 6 of 8
  runs" plus which sources were skipped and which local path they lack.
  Zero eligible sources is the only creation error.
- Removing the derived bundle removes the definition and every member;
  members are outputs and are not individually removable.
- The session persists only the definition: `DerivedBundleState { name,
  expr }` in a required `derived_bundles` array (session v16, rung
  defaults `[]`). Per-member results are recomputed, never persisted.
- Protocol v13 adds `create_derived_bundle` / `remove_derived_bundle`
  with a result carrying created member summaries and skipped members;
  the existing single-signal `create_derived` is unchanged.
- Formula bar: dragging a bundle row inserts its quoted local path
  (reusing `quoteSignalPath`/`insertSignalReference`); completions list
  bundle local paths alongside full paths, labeled with a run count. No
  other UI is added.

### Partial-bundle rule (binding)

Bundles legitimately contain different member counts (`temperature` in 7
of 8 runs). Every operation that resolves a local path across sources
must degrade gracefully, uniformly:

1. Resolve **per source**; never bind one source's signal to another
   source's operation (no cross-pairing, no cross-coloring, no
   cross-evaluation).
2. **Skip** sources that lack a required local path; never fail the whole
   operation because membership is partial.
3. Surface partiality as counts or muted states, never as errors: the
   bundle badge (`7 runs`), the omitted XY trace, the uncolored trace,
   the muted favorite chip, the derived-bundle skip report.
4. Multi-input operations (derived bundles, bundle-vs-bundle XY) use the
   **intersection** of eligible sources.

This rule already governs plotting (available members), XY X resolution
(trace omitted), the color channel (trace uncolored), highlights (stale
entries ignored), and bundle favorites (muted chip); derived bundles and
any future operation (export selection, statistics) must follow it.

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

**Session** bumps 14 → 15 (bundle favorites):

- Add a required `favorite_bundles: string[]` to `Session` (bundle local
  paths; `favorites` keeps full signal paths, unchanged).
- The v14 → 15 rung defaults the array to `[]` — no other rewriting.
- Stale entries are harmless by construction (a local path with no current
  members renders muted), so no cleanup pass is needed.

**Session** bumps 15 → 16 (derived bundles):

- Add `DerivedBundleState { name: string, expr: string }` and a required
  `derived_bundles: DerivedBundleState[]` to `Session`.
- The v15 → 16 rung defaults the array to `[]`.
- **Protocol** bumps 12 → 13: `create_derived_bundle` /
  `remove_derived_bundle` request/response types (created member
  summaries plus skipped members with their missing local paths).

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
- Scale tests cover per-set bundle keying (two sets sharing a local path
  yield two bundles under two set headers; one set yields no header),
  nested local paths producing group rows with collapse, namespaced
  collapse keys not colliding with source-prefix groups, and the sources
  footer summary/expansion.
- Bundle-favorite tests cover starring a bundle row, the v14 → 15 rung,
  favorites-bar chips resolving current members (including the
  zero-member muted state), and session/snapshot round trips.
- Derived-bundle tests cover reference resolution precedence (full path
  wins over local path), intersection eligibility with skip reporting,
  mixed full-path + bundle references, span rewriting per member,
  re-expansion after ingest, composition (`'derived/<name>'` as a bundle
  reference), removal cascade, the v15 → 16 rung, and formula-bar
  completions/drag insertion for bundles.
- Partial-bundle audit tests assert the skip-never-fail rule across every
  operation in one place: plot, XY X, color, highlights, favorites, and
  derived bundles against a fixture where one source lacks the shared
  local path.
- Reserved-prefix tests: a derived bundle renders as a top-level bundle
  row labeled by name (no `derived` group row anywhere in the output),
  sorts by its label among sibling bundles, and an unsourced derived leaf
  is likewise ungrouped; creation rejects derived bundle names containing
  `/`.
- Session tests cover the v13 → 14 rung: band panel expands to sorted
  member series, `member_filter` respected, missing members skipped,
  duplicates avoided, unresolvable `set_key` degrades gracefully.
- Snapshot tests cover `listSets` derived from the baked session (bundle
  rows survive without baked ensembles) and serialized highlights.
- Playwright covers the end-to-end bundle selection flow.
- Grep gates: `ensemble` appears nowhere in `frontend/src`, `shell/`, or
  `core/scope-core/src` outside the session migration rung and its fixture;
  `spaghetti` and `PanelSeriesKind` appear nowhere.
