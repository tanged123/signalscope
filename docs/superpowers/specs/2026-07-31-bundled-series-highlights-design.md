# Bundled Signals and Per-Panel Source Highlights

## Decision

Source bundles are a tree/navigation concept, not a plot type. Plotting a
bundle expands it into ordinary per-source series. Every panel mode (`T`,
`XY`, `FFT`, and `H`) consumes the same series state and data-plane queries.
The bundle-level `band`, `spaghetti`, and `single` choices are removed.

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

## Panel state and rendering

Bundle members are stored in `PanelState.series` with their complete source
paths. Add serialized `highlighted_sources` entries containing `{local_path,
path}`. A panel keeps at most one highlighted member for each local path; a
panel containing multiple bundles may therefore highlight one member in each
bundle.

The series inspector gains a highlight action and the legend marks the active
member. Highlighted members render at normal emphasis while non-highlighted
members in that bundle are dimmed. Hover emphasis remains transient and takes
precedence while the pointer is over a legend chip. Visibility, style, and
remove actions continue to operate on individual series.

New bundle plots never set `PanelState.ensemble` or call ensemble tile
queries. Time panels query ordinary tiles; XY, FFT, and histogram panels query
ordinary samples. Existing ensemble protocol/core types remain available for
legacy snapshots during this change, but new sessions and exports contain
member series instead of band state.

## Schema and migration

Add `HighlightedSourceState` and a required `highlighted_sources` array to the
session schema. Bump the session schema from 13 to 14 and add a migration that
defaults the array to `[]` for v13 sessions. Regenerate Rust and TypeScript
outputs; do not edit generated files by hand.

Workspace mutations enforce the one-highlight-per-local-path rule, clear
entries when a series is removed, and preserve the state through session and
snapshot round trips.

## Validation

- Tree-model and tree-view tests cover bundle expansion, bundle/member
  activation, search, and drag payloads.
- Workspace tests cover replacement and cleanup of per-bundle highlights.
- Renderer tests cover multiple emphasis indices and mixed highlighted and
  unhighlighted members.
- Panel/data-plane tests cover a two-source bundle in `T`, `XY`, `FFT`, and
  `H`, ensuring ordinary tile/sample requests are used.
- Session, snapshot, and Playwright tests cover serialized highlights and the
  end-to-end bundle selection flow.
