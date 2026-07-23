# ADR 0006: Linked-time model with streaming reservation

- Status: Accepted
- Date: 2026-07-23

## Decision

Global time state is `{ t0, t1, linked, cursor_t, mode }`. Time panels participate directly. XY panels retain their own x/y display ranges but filter trajectories by the global time window and map the global cursor time to a trajectory marker. FFT and histogram panels declare whether their computation window participates.

Updates carry an origin panel identifier so the controller can avoid feedback loops. Unlinked panels retain a local time window. `mode` is initially `fixed`; a reserved `follow` mode later represents a moving window with an explicit paused state. No v1 action changes a fixed window into follow implicitly.

## Consequences

Time remains the workspace spine without forcing all plot modes onto a time x-axis. The model can admit live data and a remote plane later without changing panel state semantics.
