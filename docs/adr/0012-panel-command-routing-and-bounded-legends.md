# 12. Panel command routing and bounded legends

Status: Accepted

## Context

Panel focus originally combined three responsibilities: a serialized target for
panel-scoped keyboard commands, a pointer selection gesture, and a persistent
amber outline. Because every panel control also receives pointer input, clicking
split, maximize, a mode, or a legend chip could toggle that selection as a side
effect. The visible focus state therefore competed with the operation the user
was actually performing.

Panel headers also rendered every legend chip inline. The legend was allowed to
shrink and clip while the action group could shrink with it, so adding many
series silently hid both identity and panel controls. This cannot scale to
Monte-Carlo workloads.

## Decision

1. `focused_panel_id` remains in the session format for compatibility and as an
   internal routing target. It means "last-used panel", not visible selection.
   Setting it is idempotent; pointer interaction never clears it.
2. Panels do not render a persistent focus outline. Amber remains available for
   transient interaction roles such as drag targets, cursors, and pinned runs.
3. A panel header renders at most three series chips. Additional series are
   represented by an explicit `+N` button that opens a keyboard-accessible,
   vertically scrollable list. Split, maximize, and close controls never shrink
   behind legend content.
4. The overflow list is an individual-series fallback, not the final
   Monte-Carlo representation. Family grouping, min/max envelopes, hover
   isolation, and pinned runs remain a later model and protocol feature.

## Consequences

- Panel-scoped commands route to the most recently created or interacted-with
  panel without requiring a separate select/unselect gesture.
- Direct controls no longer have a visible focus side effect.
- Hundreds of individual series remain reachable without widening the header,
  although querying and drawing hundreds of raw series is not promised to be
  performant or legible.
- The serialized field keeps its existing wire name until a future session
  schema migration has a stronger reason to rename it.
