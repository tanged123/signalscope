# 19. Prepared plot capabilities

Status: Accepted

## Context

Cursor inspection, retained annotations, deltas, statistics, and interaction
rules were originally implemented as time-series behavior with mode checks
added as XY, FFT, and histogram panels arrived. That made each standard plot
feature depend on a growing matrix of booleans and coordinate conversions.
Adding another panel type would require editing the panel shell, overlay, and
feature-specific branches in lockstep.

The features are common, but their semantics are not. A time plot has linked
time and raw-value statistics; an XY plot has trajectory coordinates and an
optional colour channel; an FFT has frequency/amplitude; a histogram has
source values and bin counts.

## Decision

Each render pass prepares one exhaustive `PreparedPlot` adapter for the active
panel mode. The adapter owns:

- cursor hit-testing, readout rows, markers, and link scope;
- annotation hit-testing and domain-tagged anchors;
- dynamic resolution of retained annotations into current plot coordinates;
- domain-native delta text and geometry;
- domain-native statistics; and
- pan, zoom, fit, and window-note policy.

The panel shell only renders the adapter's results and persists its annotation
anchors. The overlay accepts resolved plot coordinates and mode-native copy; it
does not infer time, frequency, trajectory, or distribution semantics.
Annotations remain panel-local and retain separate domain sets when a panel
switches modes.

Adding a panel mode therefore requires a new adapter and an exhaustive policy
entry. It must not add another capability boolean table or host-identity
branch.

## Consequences

- Standard plotting features have one extension point and work consistently
  across current modes.
- Derived-domain annotations move or become unavailable honestly when the
  underlying transform or binning changes.
- Session persistence remains stable because stored anchors are domain data,
  not screen coordinates.
- Rendering paths may remain specialized for performance, while their
  inspection and analysis behavior is presented through one interface.
