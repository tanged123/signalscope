# ADR 0022: Durable session persistence

- Status: Accepted
- Date: 2026-07-27

## Context

Workspace state lived only in memory. `WorkspaceModel.snapshot()` had no
production caller, the theme was additionally stored in `localStorage`, and
closing the application discarded every panel, layout, and derived definition.

## Decision

`scope-core::session` owns session file IO. Writes go to a sibling temporary
file and are renamed into place, so an interrupted write cannot truncate the
previous session. The frontend debounces changes and the native side performs
the write.

An autosave slot in the application data directory is written continuously and
restored on launch without a prompt: the application resumes where it was left.
Named workspace files are separate and explicit, so the unsaved indicator means
only "not yet written to the named file".

Named saves default to `workspace.signalscope.json`; an extensionless name gains
the `.signalscope.json` suffix. Opening remains unfiltered so valid legacy or
extensionless session files can still be selected and validated by
`scope-core::session`.

Save prompts for a path only while the workspace is unnamed, then overwrites
that named file. Save As always prompts and adopts the newly selected path.

New Workspace resets both presentation and native data state, writes the empty
session into the autosave slot, and leaves named workspace files untouched.

Sessions cross the protocol boundary as JSON strings rather than as generated
protocol types. The protocol and session schemas have independent generators,
and routing every load through `session::from_json` keeps migration in one
module.

Loading a session re-ingests its `source_paths` and then replays its `derived`
definitions in order. A definition whose references are absent stays recorded
and is not registered; its panels show the unresolved-signal empty state.

The `localStorage` theme key is removed. The session is the single durable
store for the theme.

## Consequences

Panels, layout, annotations, theme, and derived definitions survive a restart
and a crash. `snapshot()` becomes load-bearing and is locked against
`Session::default()` by `protocol/testdata/session-conformance.json`. Opening a
session before its data is a supported order rather than an error. Sessions
still contain no samples, so a session file stays small regardless of input
size.
