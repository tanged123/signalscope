# ADR 0033: Runtime format provider registry

- Status: Accepted
- Date: 2026-08-03
- Amends: [ADR 0009](0009-ingest-jobs-and-progress.md)

## Context

Adding a decoder used to require editing a closed `SourceFormat` enum and its
dispatch table. Declarative recipes and future trusted providers need the same
selection seam without allowing input data to choose executable behavior.

## Decision

Ingest uses a runtime `ProviderRegistry`. Each provider supplies a stable id,
display metadata, extensions, a cache-ABI version, a bounded content probe,
and a decoder factory. Selection reads at most 8 KiB and chooses the maximum
of `(confidence, priority, provider id ascending)`, independent of registration
order. An input with no claimant fails closed and reports the known formats.

The built-in CSV provider claims only plausible text: valid UTF-8 (including a
truncated probe tail), no NUL bytes, and a bounded control-byte ratio. MCAP
claims its magic bytes with certain confidence. This intentionally changes
unknown binary input from an implicit CSV fallback to an unsupported-format
error.

Provider ids and cache-ABI versions are part of decode provenance. Reopening a
source uses its recorded provider id; an unavailable provider is reported and
never replaced by a fresh sniff. Registry-derived descriptors drive native
pickers, folder scanning, drag-drop acceptance, and the format-listing
protocol response.

## Consequences

Adding a provider no longer changes central dispatch, and selection remains
deterministic when recipes register providers at runtime. Changing a provider
or its cache ABI invalidates its cache entries. The registry is native-host
ingest state; no provider, recipe, or decoder concept reaches the frontend or
an exported snapshot.
