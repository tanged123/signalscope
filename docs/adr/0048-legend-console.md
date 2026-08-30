# 48. Legend console and serialized overlay state

Status: Accepted

Supersedes the legend presentation in
[ADR 0012](0012-panel-command-routing-and-bounded-legends.md) and
[ADR 0013](0013-responsive-panel-legends.md).

## Context

The panel legend strip and in-plot legend duplicate series identity and roster
access. The strip permanently removes plot height, while the overlay can be
hidden and loses the only readout that sits beside the data.

## Decision

The in-plot legend is the panel's only series surface. Its size ladder is badge,
focused keys, searchable virtual roster, and a right-edge rail. Dropping a
floating legend on the right edge docks it; an edge target previews the dock
before release, and the plot reflows around the rail,
and the rail's return control restores the floating roster. Like the signal
dock, dragging the rail seam below its collapse threshold leaves a five-pixel
reopen seam and returns the plot width. The legend cannot be hidden without a
reopen affordance. Position, size, state, snapped corner, and dismissal of the
initial empty-focus hint are serialized per panel in session schema version 23.
Version 22 sessions migrate to the default top-left keys state.

## Consequences

- Every panel returns 26 pixels to its plot and retains a bounded series
  readout.
- A docked panel roster can remain full-height without occluding traces.
- Session and snapshot round trips preserve the operator's legend layout.
- The legend roster owns series focus and mute controls; line and axis settings
  remain panel configuration.
