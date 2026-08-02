# ADR 0031: Remove source alignment metadata

- Status: Accepted
- Date: 2026-08-02
- Amends: [ADR 0004](0004-versioned-protocol-and-codegen.md) and [ADR 0005](0005-session-schema-versioning.md)

## Context

Source alignment metadata was persisted and exposed in source summaries, but
tile and sample queries continued to consume raw timestamps. The metadata was
therefore disconnected from the time-bearing APIs it appeared to describe.

## Decision

Protocol v14 removes source alignment types and leaves `SourceSummary` with
only source identity, path, prefix, and point count. Session v19 removes the
same metadata from `SourceRecord` and deletes the core alignment model and
shell command. A v18 session migrates by dropping `time_domain`, `scale`, and
`offset` from every source record before deserializing as v19.

Raw stored timestamps remain unchanged. Any future clock normalization must
transform every time-bearing API consistently, including tile and sample
queries, rather than adding metadata that only some consumers apply.

## Consequences

Existing v18 session files remain loadable without preserving disconnected
alignment state. Source identity and decode provenance continue to round-trip;
normalization is a future cross-layer protocol decision.
