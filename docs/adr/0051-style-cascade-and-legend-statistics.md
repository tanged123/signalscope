# 51. Style cascade, legend analysis, and inspection state

Status: Accepted

Amends [ADR 0005](0005-session-schema-versioning.md) and
[ADR 0048](0048-legend-console.md).

## Context

The serialized legend console removed the duplicate header legend, but line
styling still had two unrelated editors: a series popover wrote literal values
while a rules popover changed a set-wide color mapping. Neither surface stated
precedence. The panel toolbar did not expose the defaults consumed by flat
rules, and its binding drawer repeated the legend roster.

Visible-region statistics were rendered in a bottom strip. That strip repeated
legend identity, wrapped with series count, and resized the plot whenever it was
toggled, invalidating visual comparisons.

Pinned data tips repeated the same mistake: a bottom register duplicated each
plot label and resized the plot, while a delta banner attached pairwise
measurements to individual points. Focused series were likewise copied into a
second stack above the roster instead of being marked on their canonical rows.

## Decision

Line properties resolve in three ordered scopes: panel default, legend encoding
rule, then explicit series override. The panel toolbar edits only plot-wide
defaults. The legend permanently captions color, dash, and width encodings and
owns literal row overrides. A dimension can bind to only one property; assigning
an occupied dimension swaps the two bindings. Override provenance is visible at
the field, row, and legend-footer levels.

Encoding dimensions control how properties are assigned; they do not group
legend identity. Keys and roster states contain one canonical row for every
resolved signal, including signals that share a source, so every rendered trace
has a direct focus, mute, statistics, and line-properties target.
The signal heading collapses or expands this canonical roster independently of
the annotation manifest.

The floating series popover is replaced by an inline legend-row inspector.
Plot-local derivation and row-level unbinding are removed from the style
surface. Derivation remains upstream and binding removal remains in the binding
drawer.

Per-series statistics render as sortable, configurable columns on the existing
legend roster. A floating legend continues to overlay the plot. Only the
existing explicit rail-docking gesture may reflow plot geometry. The statistics
scope implemented by the current tile response is explicitly named `visible
region`; unavailable scopes are not advertised.

Panel defaults, encoding bindings, visible statistic columns, and sort state
are serialized. The session schema advances with a migration that reproduces
the previous color-by rule, solid dash, 1.4 px width, 50% ghost opacity, and
unsorted default statistic columns. New panels use a 2 px line-width default;
the migration retains 1.4 px only to preserve existing session appearance.

A data tip is a retained sample readout, not a pairwise measurement. Its pinned
value is authoritative, and its plot label prints only axis-ordered values plus
an optional label. Delta and slope computation is removed. Labels stay in plot
space with serialized pixel offsets and bounded collision nudging; markers-only
and hidden display modes retain the pins without changing panel geometry.
Session schema 26 adds the offset and panel display mode, migrating schema 25
tips to the 10 px up-right default.

The annotation manifest is a bounded, scroll-contained legend section with
series identity, sorting, locate, delete, and CSV actions. It replaces the
normal-flow annotation register. Selection is transient and outlined; hover is
achromatic and cross-highlights the corresponding trace and legend row.

Focus remains a serialized set and remains available as an encoding dimension,
but it has no duplicate stack. Canonical legend and statistic rows receive the
amber tint and left rule in place. A focused trace retains its series hue and is
drawn one pixel wider. The user-facing `dim` control determines whether
non-focused traces retain full color or use the serialized ghost opacity; the
legacy schema field names remain unchanged. Plain row or trace click adds to the
focus set without removing prior focus, Command/Ctrl-click adds or removes,
Shift-click selects the contiguous visible range from the last anchor, and the
focused-only control filters the existing list without reordering it.

The legend's `rail` state is independent from its dock edge. Session schema 27
persists left, right, top, and bottom rails; schema 26 rails migrate to the
previous right edge. Only dragging the legend to an edge docks it. Resizing a
floating legend changes its floating dimensions and never implicitly docks it.
Unpositioned floating legends default to the top-right so inline y-axis labels
remain clear.
The bounded tip manifest yields height to the series roster in compact layouts,
and rails retain a combined x/value readout instead of hiding both numbers.

## Consequences

- One editor owns each scope and the rendered value has a deterministic source.
- Encoding captions and override debt remain visible in floating and rail
  legends.
- Statistics reuse legend scrolling, focus, mute, and docking instead of
  creating a second series surface.
- Turning statistics on no longer changes plot size.
- Pinning any number of data tips no longer changes plot size or creates an
  implied pairwise measurement.
- Each series appears once in a legend state; focus, selection, hover, mute, and
  override provenance compose as paint on that canonical row.
- New renderer-level choices such as log scales, curve interpolation, and
  explicit decimation remain absent until their behavior is implemented.
