# 51. Style cascade and legend statistics

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

## Decision

Line properties resolve in three ordered scopes: panel default, legend encoding
rule, then explicit series override. The panel toolbar edits only plot-wide
defaults. The legend permanently captions color, dash, and width encodings and
owns literal row overrides. A dimension can bind to only one property; assigning
an occupied dimension swaps the two bindings. Override provenance is visible at
the field, row, and legend-footer levels.

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
unsorted default statistic columns.

## Consequences

- One editor owns each scope and the rendered value has a deterministic source.
- Encoding captions and override debt remain visible in floating and rail
  legends.
- Statistics reuse legend scrolling, focus, mute, and docking instead of
  creating a second series surface.
- Turning statistics on no longer changes plot size.
- New renderer-level choices such as log scales, curve interpolation, and
  explicit decimation remain absent until their behavior is implemented.
