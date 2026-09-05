# ADR 0002: Layer boundaries

- Status: Accepted
- Date: 2026-07-23

Current guidance: [ADR 0038](0038-browser-only-host.md) and
[ADR 0049](0049-electron-distribution-shell.md) replace the Tauri host below.
[ADR 0053](0053-module-boundaries-and-shared-primitives.md) and
[ADR 0054](0054-evidence-backed-architecture-guidance.md) amend module guidance;
the current dependency/ownership map is in [architecture.md](../architecture.md).
In particular, the historical claim that crate extraction is mechanical is
replaced by an explicit API/visibility review.

## Decision

The Cargo workspace separates `scope-core` (modules `store`, `ingest`, `pyramid`, `compute`, `session`) and `scope-protocol`, the only shape shared with the frontend. The Tauri shell performs window, dialog, and IPC wiring only.

Dependencies flow inward:

```text
ingest ─┐
pyramid ├─> store
compute ┘ (planned)
session     (independent schema boundary)
shell ─────> protocol + core crates
frontend ──> generated protocol types
```

Decoders implement one streaming ingest trait. Storage exposes signal metadata and typed time/value access without leaking a source format. Compute consumes signal views or protocol tiles, never shell state. A future local HTTP/WebSocket host can reuse the core crates and protocol without embedding Tauri.

## Consequences

The initial in-memory store is an implementation behind a boundary that admits mmap-backed columns and on-disk source registries. No remote daemon is built in v1, but the dependency graph does not preclude one.

## Amendment (2026-07-24)

The five core layers live as modules of one `scope-core` crate rather than
five crates. The dependency arrows above are unchanged and are enforced by
module imports and review: `ingest`, `pyramid`, and `compute` may import
`crate::store`; `session` imports no sibling module; no module imports the
shell. `scope-protocol` remains a separate crate because it is the only
shape shared with the frontend. Re-splitting a module into a crate later is
mechanical because the module tree already mirrors the intended crate
boundaries.
