# ADR 0020: Three-strip chrome and hidden application menu

- Status: Accepted
- Date: 2026-07-26
- Supersedes: the global-toolbar and inert-menu decisions in ADR 0010

## Context

The 2026-07-25 chrome and rendering audit found that global controls occupied
five horizontal rows, time state was split across the toolbar and status bar,
and one-shot actions competed with persistent workspace state. The shipped
cursor also combined three drawing styles with a separate status readout,
rather than expressing the audit's `none`, `track`, and `measure` workflows.

SignalScope still has two presentation hosts. Drawing native window controls
inside the shared frontend would either duplicate Tauri decorations or make
the snapshot pretend to own an operating-system window.

Several conventional File, View, and Workspace actions are planned but do not
yet have backing Rust IPC or export/session workflows. Keeping them visible is
useful as an explicit roadmap surface, provided they cannot mutate state and
are clearly identified as planned.

## Decision

The application chrome has three permanent strips:

1. a title strip containing the hidden-menu button, wordmark, and current
   session identity;
2. the persistent workspace-tab strip, with a planned layout-preset control;
3. a status strip containing dock toggles and source truth on the left, and
   contextual gesture, cursor mode, linked-time, and palette state on the
   right.

There is no global toolbar row. Native operating-system decorations remain
enabled and the shared title strip does not draw minimize, maximize, or close
glyphs. This preserves ADR 0001's single presentation plane across the Tauri
and baked snapshot hosts.

The `≡` popover and command palette are views of one command registry. Commands
carry menu section, grouping, availability, keybinding, and optional checked
state. Available items execute the same registry entry from either surface.
Planned File/export/workspace/preset/preferences entries remain visible,
dimmed, labelled as planned, and non-destructive. This deliberately reverses
ADR 0010's rule that inert conventional entries must be omitted.

Cursor behavior is a workspace-scoped state machine:

- `none` draws no cursor and shows no persistent cursor-mode label;
- `track` draws a hairline and visible-series markers and shows the in-panel
  popup readout;
- `measure` retains the hairline and emphasizes pinned anchors and delta
  measurements without the popup.

`C` cycles the mode. Session schema version 7 adds the mode to every
`WorkspaceTab`, with a v6 migration default of `none`, following ADR 0005.
Annotations remain pinnable and visible in every cursor mode. This is an
intentional divergence from the audit's suggestion that pinning belong only
to `measure`: cursor mode controls cursor rendering, not annotation access.

Theme is a global preference persisted under a namespaced local-storage key.
Font size, palette, axes defaults, workspace persistence, export, and layout
presets remain planned entries until their backing work lands.

## Consequences

Plot space increases while durable workspace tabs remain visible. Time state
has one stable home, and transient values remain close to the pointer in the
track popup. The registry becomes the source of truth for menu and palette
discoverability.

Planned entries must consistently expose `aria-disabled`, a dim visual state,
and explanatory text so they cannot be mistaken for broken actions. New menu
commands must be registered once rather than wired directly to the popover.
Every future session schema bump must migrate the per-workspace cursor mode.
