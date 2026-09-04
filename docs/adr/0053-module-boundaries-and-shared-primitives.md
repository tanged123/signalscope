# ADR 0053: Module boundaries and shared primitives

- Status: Accepted
- Date: 2026-09-04
- Amends: ADR 0002

## Context

ADR 0052 established typed plot-family seams and ADR 0002 established layer
boundaries. Neither constrains module _size_, and ten files in the repository
now exceed a thousand lines. Two of them, `app-shell.ts` and `panel.ts`, hold a
third of their content in a handful of methods.

Large modules are not a style problem here. They are the reason a second plot
family costs more than it should: an implementer must read a 3,452-line file to
find the eight lines that dispatch on plot kind, and a reviewer cannot tell
whether a helper is panel-specific or reusable. Duplication has the same cause —
a helper hidden inside a large module is invisible, so the next author writes it
again.

A survey of the repository found three helpers implemented more than once and
one UI pattern implemented three times.

## Decision

### Size budget

Modules have a soft budget of **600 lines** and a hard review trigger at
**1,000 lines**. Rust files are measured on implementation lines, excluding the
inline `#[cfg(test)]` module; a file that is large only because its tests are
large is not a violation.

Crossing 1,000 lines does not require an immediate split, but it forbids adding
new behavior to that module until the split is done. This is deliberately a
ratchet: it stops growth without demanding a stop-the-world refactor.

Splits follow cohesion, not line count. A module is a candidate when its
methods form clusters that share no state with each other.

### Named seams

The following splits are accepted. They are staged, not yet performed, and each
is independently landable. Line counts are measured on this branch.

**`frontend/src/ui/panel.ts` (3,452)**

| Extract                     | Lines | Into                   |
| --------------------------- | ----- | ---------------------- |
| Legend console rendering    | 1,011 | `ui/legend-console.ts` |
| Anchored menus and popovers | 310   | `ui/anchored-menu.ts`  |

The legend cluster is `plotLegendStats` (200), `plotLegendTips` (132),
`inlineSeriesInspector` (132), `plotLegendRoster` (113), `plotLegendSeriesRow`
(62), `plotEncodingDrawer` (57), `legendRailHost` (51), `seriesLegendRows` (49),
`plotLegendKeys` (45), `plotLegendEncodingRow` (42), `bindPlotTipsResize` (42),
`plotLegendFooter` (40), `plotLegendGroupTitle` (35), `plotLegendDrawers` (11),
orchestrated by `updatePlotLegend` (158). Legend _geometry_ already moved to
`ui/legend-rail.ts`; legend _content_ did not. It takes a host port in the same
shape, so a future panel type can render a legend without inheriting panel code.

**`frontend/src/ui/app-shell.ts` (3,531)**

| Extract                        | Lines | Into                         |
| ------------------------------ | ----- | ---------------------------- |
| `registerCommands`             | 503   | `ui/command-registry.ts`     |
| `mount`                        | 417   | staged composition steps     |
| `shellMarkup` + `bindControls` | 229   | `ui/shell-markup.ts`         |
| Export dialog and selection    | ~360  | `ui/export-flow.ts`          |
| Cursor, tooltip, live values   | ~250  | `ui/cursor-readout.ts`       |
| History, autosave, preferences | ~200  | `app/session-persistence.ts` |

`registerCommands` and `mount` are single methods. Together they are 26% of the
composition root, which makes splitting them the highest-value frontend change.

**`server/scope-server/src/api.rs` (936 implementation lines, ~35 handlers)**

Split into `api/{dialogs,ingest,query,derived,session,export,preferences}.rs`.
`api/query.rs` becomes the single place a new plot family adds its endpoint,
which is what ADR 0052 step 4 refers to.

**`core/scope-core/src/snapshot.rs` (857 implementation lines)**

Extract the selector and glob engine — `parse_selector`, `parse_glob`,
`selector_matches`, `glob_matches`, `glob_branch_matches`, roughly 180 lines —
into `scope-core/src/selector.rs`. It is not a snapshot concern and it is
currently duplicated (see D3).

**`core/scope-core/src/cache.rs` (753)** — extract the column codec
(`encode_column`, `encode_bins`, `decode_bins`, `pad_to_8`, `append_section`,
`section_bytes`, `digest_bytes`) into `cache/codec.rs`.

**`core/scope-core/src/expr.rs` (795)** — split along the phases already present
in the file: `expr/lex.rs`, `expr/parse.rs`, `expr/eval.rs`.

**`frontend/src/styles/app.css` (3,244 lines, 481 rule blocks, one comment)** —
split into `styles/{tokens,shell,panel,legend,dialogs,outline}.css`. This file
has no internal structure at all, which makes every visual change a full-file
search.

**`frontend/src/app/workspace.ts` (1,266)** — lowest priority. It is ~100 small,
cohesive methods over one session document. Split by facet (tabs, layout,
series and style, legend, sets and derived, sources) only when it next needs to
grow.

### Shared primitives to create

Four helpers exist more than once. Each becomes one implementation.

**D1 — padded time-window bounds.** `line2d.rs::window_bounds` and
`compute.rs::sample_window_bounds` are identical apart from a parameter name;
`scope-server::host.rs` carries a third variant over `ColumnGuard`. All three
compute the index range covering `[t0, t1]` plus one sample of context on each
side. Consolidate into `scope-core::time_window`, with a column-backed overload.

**D2 — sorted binary search.** `lowerBound`/`upperBound` are defined three
times: `app/samples.ts`, `app/data-plane.ts`, and `app/tile-window-cache.ts`,
differing only in whether they take `readonly number[]` or `Float64Array`.
Consolidate into `app/binary-search.ts` over `ArrayLike<number>`.

**D3 — glob matching.** `snapshot.rs` implements a parsed glob with backtracking
and `ingest/recipe/decode.rs` implements a separate string glob. Two engines
means `*` can mean two things depending on where a user types it. The extracted
`selector.rs` becomes the single implementation, and recipe decoding uses it.

**D4 — anchored dismissible menu.** Implemented three times: `panel.ts`
`openPanelMenu` (60 lines, already a good primitive, but private to
`PanelView`), `app-shell.ts` `bindLegendLayoutMenu`, and `ui/app-menu.ts`. Each
registers its own capturing `pointerdown` dismissal. Promote the panel version
to `ui/anchored-menu.ts` and have the other two use it. Panel's seven
`open*Menu` call sites already have the right shape and do not change.

**D5 — test fixtures.** `signal()`, `sourceSummary()`, `state()`, `callbacks()`,
and `mockCanvas()` are redeclared across `app-shell.test.ts`,
`panel-chrome.test.ts`, `panel.test.ts`, and `workspace.test.ts`. Consolidate
into `frontend/src/test-support/`. Four test files exceed a thousand lines
largely because of this.

### What is not decided

No split changes public behavior, schema, or the protocol. If a split appears to
require a behavior change, that is a separate ADR.

Module count is not a goal. Extracting a helper used once, or splitting a
cohesive data model to hit a line target, is a worse outcome than the large
file. The budget exists to force the question, not to answer it.

## Consequences

- New behavior cannot be added to a module over 1,000 lines until it is split.
  Existing modules over the limit are recorded in
  [architecture.md](../architecture.md) and burn down individually.
- `panel.ts` lands near 2,100 lines and `app-shell.ts` near 1,800 after the
  named seams. Both remain above the soft budget; further splitting waits for a
  second concrete panel type to show where the boundary belongs, consistent with
  ADR 0052's rule that the second implementation drives the abstraction.
- Four duplicated helpers become one implementation each. D3 additionally closes
  a semantic inconsistency, not only duplication.
- Tests move with the code they cover. A split that reduces coverage is
  rejected.
- `docs/architecture.md` is the standing construction guide and is updated when
  a seam moves.
