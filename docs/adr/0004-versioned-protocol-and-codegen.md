# ADR 0004: Versioned protocol and code generation

- Status: Accepted
- Date: 2026-07-23

## Decision

`protocol/schema/scope-protocol.json` is the single schema source. A deterministic repository script generates Rust structs and TypeScript interfaces. Generated files are committed and CI fails if regeneration produces a diff.

Every request and response includes `protocol_version`. Additive fields require defaults; breaking semantics require a new version with an explicit compatibility path. Tauri IPC and baked snapshots use the same serialized names.

## Amendment (2026-07-24)

Every payload now crosses hosts inside a transport envelope
`{ protocol_version, payload }`; `Envelope::open` (Rust) and `open()`
(TypeScript) are the only version checks. Additive fields require defaults;
breaking semantics require a new version with an explicit compatibility
path. Tauri IPC and baked snapshots use the same serialized names.

Framing 1 is JSON. A binary framing for bulk `EnvelopeBin[]` transfers
(bytes decoded to typed arrays) is reserved for a future protocol version so
dense tile traffic never has to squeeze through JSON; adding it is a new
framing behind the same envelope, not a redesign.

## Consequences

Rust and TypeScript cannot drift silently. The deliberately small Phase 0 generator supports the schema constructs currently used; adding a construct requires extending and testing the generator before extending the schema.

## Amendment (2026-09-04, tagged unions)

The generator supports internally tagged unions with a required discriminator
and variant-specific required fields. Rust emits a Serde-tagged enum and
TypeScript emits a discriminated union. Schema authors use this construct for
correlated shapes instead of pairing a string enum with nullable fields and
handwritten validation.
