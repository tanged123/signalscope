# 18. Histogram semantics

Status: Accepted

## Context

The design package's entire treatment of histogram mode is the letter `H` in
the mode-pill group. It appears in no mock — not in the pixel reference, not
in the light-mode sheet, not in any empty-state card — and the spec's own
build order lists neither histogram nor FFT computation in v1 or v2. The
prototype's mode enum has two values (`time`, `xy`); there is no third branch
to extend. Bin rule, orientation, source window, normalization, multi-series
treatment, axis names, and interaction model are all undefined.

The one real requirement the package does state is indirect: the empty-panel
card says modes are "pickable before data arrives", so an `H` panel must
render a complete, empty axis frame with no signals plotted.

This is therefore a design decision, not an extraction.

## Decision

- **Source** is the visible time window, matching the FFT panel's
  `window: visible t` header token. Panning any linked panel rebins.
- **Bin count** is Freedman–Diaconis (`2 · IQR / n^(1/3)`), which adapts to
  spread rather than to sample count alone, falling back to Sturges when the
  interquartile range collapses on heavily tied data. Clamped to [8, 128] so
  a panel is never a solid block or a comb.
- **Edges are shared** across every visible series, computed from the union
  of their finite values, so overlaid distributions are directly comparable.
- **Sample counts, not densities.** Counts describe the finite values in the
  bounded `SampleResponse` slice from ADR 0015. They equal source cardinality
  only while that window is below the response cap; larger windows remain a
  bounded sampled distribution and are not presented as an exact raw-point
  total. A density would need a units caption the chrome has no room for.
- **Step outlines in series colour**, not filled bars. Filled bars occlude
  each other, and this app's identity channel is already colour-plus-text.
  Outlines let two distributions overlap and stay readable.
- **Cursor inspection is bin-local.** The line cursor reports the selected
  bin interval plus each visible series' sample count, and the dot cursor
  marks the counts at that bin. Bin values are not published as linked time.
- **Axes** are `value (<unit>)` on x and `count` on y.
- **No zoom or pan.** The bin edges are a function of the visible window, so
  dragging the x axis would show bins that no longer describe what is drawn.
  Double-click fit and the linked time window remain the controls.

## Consequences

- The `H` pill becomes honest without inventing chrome the spec never drew.
- Anything the spec later specifies — density normalization, orientation,
  cumulative mode, a bin-count control — is additive and would arrive with
  its own control surface.
- If the maintainer would rather leave `H` inert until the design pass
  covers it, this ADR and its two implementation tasks can be dropped with
  no other consequence; nothing else in Phase 2B depends on them.
