# 13. Responsive panel legends

Status: Accepted

Supersedes the fixed three-chip limit in
[ADR 0012](0012-panel-command-routing-and-bounded-legends.md).

## Context

ADR 0012 bounded panel legends to keep panel actions reachable, but its fixed
three-chip header limit wastes space when a panel is wide. A horizontal scrolling
legend would hide series without exposing their count and would add another
gesture surface beside the plot.

Series identity still needs a visible stroke sample. The sample communicates
both categorical colour and dash style, so replacing it with colour alone would
violate the series-identity invariant.

## Decision

Panel headers show as many complete legend chips as fit in the measured space
between the mode selector and panel actions. Remaining series collapse into the
existing `+N` overflow control. The layout is recomputed when the panel header
resizes.

Stroke samples remain, but use the compact reference-spec width. The overflow
menu remains the reachable individual-series fallback; family and envelope
representations remain future protocol and model work.

## Consequences

- Wide panels use their header space instead of stopping at an arbitrary count.
- Narrow panels preserve mode and panel actions while reporting every hidden
  series through `+N`.
- No horizontal scrollbar or undisclosed clipped series is introduced.
