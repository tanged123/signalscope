# ADR 0002: Layer boundaries

- Status: Accepted
- Date: 2026-07-23

## Decision

The Cargo workspace separates `scope-store`, `scope-ingest`, `scope-pyramid`, `scope-compute`, and `scope-session`. `scope-protocol` is the only shape shared with the frontend. The Tauri shell performs window, dialog, and IPC wiring only.

Dependencies flow inward:

```text
ingest ─┐
pyramid ├─> store
compute ┘
session     (independent schema boundary)
shell ─────> protocol + core crates
frontend ──> generated protocol types
```

Decoders implement one streaming ingest trait. Storage exposes signal metadata and typed time/value access without leaking a source format. Compute consumes signal views or protocol tiles, never shell state. A future local HTTP/WebSocket host can reuse the core crates and protocol without embedding Tauri.

## Consequences

The initial in-memory store is an implementation behind a boundary that admits mmap-backed columns and on-disk source registries. No remote daemon is built in v1, but the dependency graph does not preclude one.
