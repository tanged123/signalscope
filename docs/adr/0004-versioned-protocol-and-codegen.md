# ADR 0004: Versioned protocol and code generation

- Status: Accepted
- Date: 2026-07-23

## Decision

`protocol/schema/scope-protocol.json` is the single schema source. A deterministic repository script generates Rust structs and TypeScript interfaces. Generated files are committed and CI fails if regeneration produces a diff.

Every request and response includes `protocol_version`. Additive fields require defaults; breaking semantics require a new version with an explicit compatibility path. Tauri IPC and baked snapshots use the same serialized names.

## Consequences

Rust and TypeScript cannot drift silently. The deliberately small Phase 0 generator supports the schema constructs currently used; adding a construct requires extending and testing the generator before extending the schema.
