# Ghost Mode and Sets Polish Design

## Goal

Make large-series ghost mode immediately legible in every plot mode and make
saved sets inspectable and reliably draggable into panels.

## Behavior

- A ghost-mode panel with no explicit focus derives its default focus from the
  first resolved source. Every visible series from that source uses normal
  focused styling; the remaining series use ghost styling. Explicit focus
  replaces the derived default, and clearing explicit focus restores it.
- Time, XY, FFT, and histogram plots use the same ghost stroke: `--fg-4`, solid,
  1 px, and 0.5 opacity. XY color mapping does not override ghost styling.
- Track-cursor points for ghost series use `--fg-4` at reduced opacity. The
  cursor line remains amber because it represents interaction, not series
  identity. Ghost tooltip rows are also subdued.
- Grouped cursor rows use the neutral copy `<channel> · <count> signals`.
- Saved-set rows have an independent disclosure caret. Expanding a set lists
  its currently resolved signal paths; query sets therefore reflect the live
  catalog. Clicking the main row still binds the set, and dragging it still
  binds the set to the target panel by reference.
- Set rows use a grab cursor and copy drag effect to expose the existing drag
  interaction.
- The signal search placeholder is `Search signals…`.

## Architecture

Default focus is derived in panel resolution rather than written into session
state. This covers newly created and restored panels without inventing hidden
persistence mutations. Arbitrary-path rendering receives the same nullable hue
and opacity already used by time rendering, so every panel mode follows one
resolved series style.

Set expansion remains local view state. Members are resolved from the current
catalog on each render, keeping query sets live and omitting unavailable pick
members without changing stored set definitions.

## Non-goals

- Changing the session or data-plane schema.
- Changing the amber global cursor line or XY interaction marker.
- Adding set-member editing from the expanded list.
