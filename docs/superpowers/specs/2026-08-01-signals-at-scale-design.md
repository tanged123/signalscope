# Signals at scale — design spec

Date: 2026-08-01. Source: `docs/Signal Scope UI Design Pass/SignalScope Signals at Scale.dc.html`
(AUDIT v3), scoped and amended with Edward. Chrome is unchanged from AUDIT v2;
this spec covers the model and mechanisms only. Execution is one implementation
plan per rollout phase (P1–P5 below).

## Diagnosis

Every current operation addresses one series at a time, so N channels ×
M sources costs O(N×M) clicks, chips, and legend entries. The fix is an operand
change, not layout polish: formalize the two dimensions and let every
mechanism address either axis or a set spanning both.

## Model principles

- **Backend has only sources and signals.** A signal is identified by
  `(source_key, local name)`. Rust, the protocol, and the session schema never
  model "series".
- **A series is presentation-plane organization**: the cell channel × source,
  computed by the frontend catalog, never stored as a primary entity. The only
  serialized `(source_key, channel)` refs are explicit exceptions: frozen
  picks, override targets, and focus entries.
- **Panels bind selectors, not lists.** A panel bound to
  `derived/temp* @ run_*` plots 16 series today and auto-joins `run_09` when
  it loads.
- **Supersede, don't parallel.** Each phase deletes the surface it
  formalizes. No legacy affordance survives beside its replacement; old shapes
  are spelled only in migration code. Every phase plan carries an explicit
  deletion checklist.

## Core model (P1)

**Catalog** — new pure module `frontend/src/app/catalog.ts`, built from the
`SignalSummary[]` the shell already holds: sources, channels (canonical name
plus per-source aliases once the channel map exists), series = channel ×
source, attrs (unit, kind). All prefix/local-path string arithmetic collapses
into the catalog; nothing else re-derives it.

**Panel binding** — `PanelState.series[]` is replaced by:

- `bindings: Binding[]` — `{kind: "query", selector}` |
  `{kind: "pick", refs: SeriesRef[]}` | `{kind: "set", set_id}`
- `color_by: "focus" | "source" | "channel" | "set" | "attr"` — color (plus
  opacity) is the only rule-driven visual channel
- `overrides: Override[]` — `{target: selector, color?, dash?, width?,
opacity?}`, ordered, individually revertible
- `focus: FocusEntry[]` — a series ref or a dimension slice (one source or
  one channel) — `ghost_mode: "ghost" | "all"`,
  `split_by: "none" | "source" | "channel"`

`x_signal` and `color_signal` become `SeriesRef`s; color-by-time becomes an
explicit variant, retiring the `"time"` magic string.

**Resolution pipeline** — pure and deterministic:
`catalog + bindings → resolved series list`;
`resolved + color_by + overrides + focus → per-series render style`. The
renderer continues to consume a flat styled list.

## Session schema v17 — the only schema change

Defined completely in P1 even though later phases light fields up; P2–P5 are
frontend-only with no codegen or migration steps.

Removed: `favorites`, `favorite_bundles`, `source_sets`, `SeriesState`,
`PanelState.highlighted_sources`, path-string `x_signal`/`color_signal`.

Added: `named_sets: {id, name, kind: "query" | "pick", selector | refs}[]`,
`channel_map: {canonical, aliases: {source_key, name}[]}[]`, and the panel
fields above.

Migration v16→v17, one arm in the existing chain: `series[]` → one frozen
pick binding with per-series styles as overrides; `favorites` and
`favorite_bundles` → one-item named sets; `highlighted_sources` → focus
entries; `source_sets` member transforms → source records (below).
Conformance fixture updated once. Codegen constraint: no nullable `u64`;
model absence as enum variants (all new ids are strings).

## Bundle retirement

`SourceSet` splits into two parts with different fates:

- Schema-overlap union-find and fingerprints existed to propose UI groupings;
  the catalog's channel axis replaces them. Deleted.
- Per-member time alignment (`time_domain`, `AffineTransform`) is load-bearing
  but per-source, not per-set. It relocates onto `SourceRecord`; alignment
  proposal becomes a per-source flow.

Then `sets.rs`, `SetSummary` (protocol), and `Session.source_sets` are
deleted, along with all bundle UI: bundle tree rows, carets,
`BUNDLE_DRAG_TYPE`, bundle drop, one-highlight-per-bundle,
`bundleCompletionEntries`. Catalog channel rows ("temp — 9 srcs") are the
formalized replacement. Post-P1 gate: `grep -ri 'bundle\|source_set'` hits
only migration code and ADR history. `restore.rs` reconciliation is verified
against the new shape.

## Selector grammar

One module, `frontend/src/app/selector.ts`:

```
selector := channel-glob [ "@" source-glob ] { attr }
glob     := literals, *, ?, | alternation, [a-z0-9] ranges
attr     := key ":" value          (unit:K, kind:derived)
```

No boolean operators, negation, or nesting in v1. One parser and one matcher
compile to a predicate over catalog entries. Five call sites: dock filter box,
⌘P signals mode, table filter, override targets, set definitions. Deletes the
substring tree filter and fuzzy matching for signals (fuzzy stays for
commands/settings palette modes).

## Mechanisms

**Sets (§2).** Dock SETS section replaces FAVORITES. ⌘S in the filter box
saves the current query; drag a set row onto a panel binds it; badge
distinguishes live query from frozen pick. A favorite is a one-item set.
Deletes: FAVORITES section, tree-row star toggles.

**Style rules (§3).** `color_by` maps hue to one dimension; dash and width are
never rule-driven — they exist solely as manual overrides. Overrides target a
selector ("run_07 @ \*" bolds one run everywhere), render with ◆ in legend and
popover, revert individually. Palettes stay in View ▸ Series palette; rules
choose the dimension, the palette supplies hues. Deletes: per-panel
`color_slot` allocation; the inspector as primary styling surface (it becomes
the override editor).

**Matrix legend (§4).** The strip is per-dimension count tokens
(`RUN 8 ▾`) plus focused chips only — structurally identical at 8 or 800
sources, one line, never wraps or scrolls. Count-token popovers are
virtualized, selector-searchable rosters whose rows are live operands: hover
emphasizes, click focuses, ⌥click mutes, ✕ unfocuses. Panel header shows one
grouped chip per channel with `×N ▾`. Cursor popup groups the same way past
12 rows. **Hard rule: no UI surface renders one element per signal, series,
or dimension value unbounded.** Deletes: chip-per-series legend, the
`layoutLegend` per-chip reflow loop, the `+N` overflow menu, per-series
header chips.

**Ghost by default (§9).** Per panel: focus stack plus `ghost_mode`. Drops of
≤ 4 series auto-focus all of them; above that the bundle arrives fully
ghosted (fg-4, 1 px, ~50% opacity, no per-series styling, hit-testable) and
color is granted only through focus. Hover = temporary emphasis + name tag
(hover never mutates focus state); ⇧click pins focus; legend key click
focuses a slice; Tab/⇧Tab walk ghosts by value at cursor t; esc clears;
⌥click mutes; the "all" toggle rule-colors everything. Builds on the existing
`dimmed[]`/`emphasisIndex` render path. Deletes: highlight semantics and
inspector highlight actions.

_Amended 2026-08-02:_ focus is ⇧click, not plain click — plain click stays
the annotation pin/remove gesture, resolving the collision between the two
(a line click near a rendered vertex is otherwise ambiguous). Hint text
reads `hover explore · ⇧click focus · ⌥ mute · esc clear`.

**Tree-table (§6 — amended 2026-08-02; supersedes the tree/table/map
split).** One tree-table, not two modes. The dock is a single virtualized
outline table: columns always present, rows optionally grouped.
`group ← channel` reproduces the old tree (group rows expand to source
rows); `group ← none` is the flat sortable table; `group ← source` is
free. One component, one selection model, one implementation — tree vs
table was a false dichotomy, and the standalone channel-map view is
deleted with it (§5). Group rows aggregate their children (src count, pt
sum) and select all of them from the row checkbox; bulk actions operate
on the selection. The selector box filters live, so ⌘A = "select all
matching the query" — query → select → act is the bulk workflow. Sorting
a column while grouped sorts within groups; with `group ← none` it is the
classic flat table. No tabs, no modes: the only controls are `group ▾`
(channel · source · none) and a `⊞ ▾` column picker. Group-row checkbox =
select children; group-row click = expand. Selection is workspace state
(ephemeral, never serialized) and survives regrouping. One column model
at every width: canonical `CHANNEL · SOURCE · UNIT · VALUE`, priority in
that order; `PTS` and other metadata are opt-in via `⊞ ▾`. As the pane
narrows, columns drop right-to-left by priority — never squeeze, never a
second layout. The 280 px dock (§10) and the wide view are the same
component at two widths; docking it wide IS table mode. `style…` on a
selection writes a rule override (§3), never N per-series entries. Perf
rule unchanged: the dock never touches sample data — counts, units, and
last value come from source metadata; 10k rows scroll at 60 fps.
Deletes: the tree/table/map toggle, `SignalTreeView`/`SignalTableView`,
`buildTreeRows`/`buildTableRows`, the SERIES/CHANNELS granularity toggle,
and the channel-map dialog.

**Channel map (§5).** Workspace-scoped `Session.channel_map` aliases
source-local names onto one canonical channel, non-destructively, applied at
catalog build so selectors, rules, legends, and the tree all speak canonical
names. Near-match suggestions on source load use name heuristics
(case/underscore/unit-suffix) and are suggest-only — never auto-merge. Merge
gesture: multi-select → "Merge as channel…" (context menu), plus the dock's
near-match footer row. Original names stay visible on demand; unit mismatch
flags the channel (conversion is a ƒx concern).

_Amended 2026-08-02 (P8):_ the standalone map view and its ⌘⇧P shortcut are
deleted. A merged channel's `N names` chip opens a popover listing the
original per-source names with an `unmerge` action — inspection and reversal
live on the row, not in a dialog. The near-match footer row becomes the only
suggestion surface.

**Facet split (§7).** `split_by` fans the panel into small multiples sharing
the time axis (y-link toggle), one cell per dimension value, capped at 16
cells (then page or demand a tighter selector). Cells inherit panel rules
minus the split dimension. Cursor track spans cells; measure stays per-cell.
Unsplit restores the overlay — a view of the same binding.

## Cross-cutting rules

Restated from AGENTS.md because phase plans must carry them locally: amber is
interaction-only; every pointer action has a keyboard path; the renderer stays
deterministic from tiles, viewport, and tokens; snapshots remain
self-contained; dock and table never touch sample data.

Added 2026-08-02:

- **Plot interactions are mode-universal.** Hover-explore, ⇧click focus,
  ⌥click mute, Tab walk, and esc behave identically in time, XY, FFT, and
  histogram panels (and any future mode). Each mode supplies a series
  hit-test adapter; interaction handlers never branch on panel mode.
- **Per-source alignment edits are on-demand**, behind an affordance on the
  source row — never permanent per-source controls. A row of inputs per
  source is the same unbounded-element violation as a chip per series.

## Rollout

**P1 — model** (cross-layer; the only Rust-touching phase; `major` bump).
Alignment onto `SourceRecord`; delete `sets.rs` and `SetSummary`; schema v17 +
migration + fixture; catalog + resolution pipeline; rewire tree and panels to
resolved lists; delete bundle UI; FAVORITES slot becomes a minimal read-only
SETS list until P2. Gate: UI-equivalent (every existing task still doable),
workspace round-trips, bundle grep clean, `./scripts/ci.sh all`.

**P2 — selector + sets** (`minor`). Parser/matcher with table-driven tests
first; filter box promoted with live match count; ⏎ add-to-panel; ⌘S; full
SETS UX with drag-to-bind and badges; ⌘P signals mode on the grammar.

**P3 — rules + legend + ghosts** (`minor`). `color_by`, override stack and
editor, matrix legend with rosters, grouped header chips, ghost rendering,
focus stack and the full interaction set, cursor-popup grouping.

**P4 — table mode** (`minor`). Toggle, virtualized metadata-only table,
shared selection model, bulk bar. Perf gate: 10k rows at 60 fps, zero sample
fetches from the dock.

**P5 — channel map + facets** (`minor`). Map in catalog build, near-match
suggestions, merge gesture, map view, ⌘⇧P; facet split with cell cap, rule
inheritance, shared cursor.

**P8 — tree-table consolidation** (`minor`; after the P6/P7 remediations).
The dock's tree mode, table mode, and channel-map view collapse into the
single outline table of §6 (amended): `group ▾` + `⊞ ▾` replace the
three-way toggle, the bulk bar becomes the outline's footer, and the map
dialog's unmerge moves onto the merged-channel row.

## Acceptance (from AUDIT v3 §8)

- Load 20 sources × 500 channels: dock interactive < 100 ms; no unbounded
  per-series UI element anywhere (P1, re-verified P4).
- Recolor all runs in a 64-series panel: one action, < 5 s (P3).
- Isolate run_07 across a full workspace: one legend click (P3).
- temp / temperature / T_amb plot as one channel after one merge; originals
  recoverable (P5).
- Workspace round-trips selectors, sets, rules, overrides, focus, and the
  channel map (P1, re-asserted every phase).

## Testing

Pure modules first in Vitest — parser, catalog, resolution, migration are pure
functions and get table-driven tests before UI wiring. Playwright covers each
new interaction surface (sets drag-bind, focus/ghost gestures, roster
popovers, table bulk actions, merge flow). The session-conformance fixture
changes once, in P1. Cross-layer P1 runs `./scripts/ci.sh all`; later phases
run the affected suites plus the frontend gate.
