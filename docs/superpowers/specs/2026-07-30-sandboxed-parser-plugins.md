# Sandboxed parser plugins

**Status:** Proposed implementation spec

**Date:** 2026-08-03

## Goal

Allow a developer to add a decoder for a format that is not built into
SignalScope without weakening the native ingest transaction, cache provenance,
or snapshot boundary. This spec covers the plugin host contract. It does not
implement plugins.

## Non-negotiable trust boundary

The sandboxed plugin path is WebAssembly executed by a native wasmtime host.
The module receives no filesystem, network, clock, process, or environment
capability. The host supplies source bytes and receives decoded batches through
one WIT component interface.

A native subprocess is not a sandbox: it has the user's filesystem and network
privileges. If subprocess plugins are offered, they are developer-mode only.
Each executable must be explicitly registered in preferences by its absolute
path and digest. Executables are never discovered in a data directory,
sidecar, recipe, or plugin search path. The registration is a trust decision,
not a substitute for isolation.

The first implementation ships one transport and one encoding only: the
wasmtime host-call interface with WIT records containing UTF-8 metadata and
little-endian `f64` sample arrays. No alternate IPC, JSON, Arrow, shared-memory,
or native ABI is part of the initial compatibility surface.

## Logical API

The host drives one file transaction:

```text
open(source metadata) -> parser handle
stream column batches -> zero or more batches
finish -> parser summary
```

The logical WIT surface is:

```text
record parser-info {
  id: string,
  label: string,
  extensions: list<string>,
}

record column-batch {
  name: string,
  unit: option<string>,
  values: list<float64>,
}

record parser-summary {
  time-name: string,
  row-count: u64,
  column-count: u32,
}

interface parser {
  open: func(source-name: string, source-size: u64) -> result<_, parser-error>;
  next-batch: func() -> result<option<column-batch>, parser-error>;
  finish: func() -> result<parser-summary, parser-error>;
  cancel: func();
}
```

The exact WIT spelling is owned by the eventual protocol package; the logical
operations and field meanings above are fixed here. A plugin emits one column
at a time, and the host owns the source stream, batch sequencing, and commit.
The plugin does not receive a path or an open file handle.

## Host validation and transaction

The host treats every plugin result as hostile. It validates:

- provider id, labels, units, and signal names against byte and count limits;
- names through `naming::normalize_segment`, with duplicate normalized names
  rejected rather than overwritten;
- one declared time column whose values are finite and monotonically
  nondecreasing, using the same validation and sorting semantics as CSV;
- equal column lengths, declared row counts, and batch boundaries;
- maximum signal count, maximum name length, maximum batch samples, and maximum
  total samples before allocating or committing;
- that `finish` is reached only after the declared columns and rows agree.

The host buffers or spills decoded columns through the existing ingest and
`admission::MemoryBudget` paths. Registration occurs only after validation and
uses the existing per-file transactional `commit` path. Any parser error,
validation failure, cancellation, timeout, or resource-limit breach discards
the decoded result and leaves the store unchanged.

The host terminates a module that exceeds its fuel or deadline budget, exceeds
its memory cap, emits a batch or total output over the configured limit, or
does not respond to cancellation. A plugin cannot convert an error into a
partial source.

## Resource limits

Each invocation gets host-configured limits for wasm linear memory, wasmtime
fuel, wall-clock deadline, maximum batch samples, maximum total samples,
maximum signals, maximum normalized name length, and maximum output bytes.
Defaults are conservative and are reduced by the file and job admission
budgets. Limits are checked before growing host-owned buffers. The host does
not promise that a module's own allocation strategy is safe merely because its
output is small.

Cancellation is checked between host calls and batches. The host invokes
`cancel`, waits only for the cancellation deadline, then terminates the module
if it remains unresponsive. Termination follows the same rollback path as any
other parser failure.

## Registration, provenance, and cache

An installed WASM module is registered explicitly by a trusted developer
configuration. Its provider id, declared metadata, module SHA-256 digest, and
cache ABI are captured when the provider is registered. Provider selection
continues to use ADR 0033's deterministic confidence, priority, and id order;
data files and recipes cannot register a module.

The module digest joins `provenance_digest`'s options along with the provider
id and cache ABI. Rebuilding a plugin therefore invalidates its cached columns
even when the provider id is unchanged. A session records the provider and
provenance needed to reopen it; an unavailable or changed plugin fails clearly
and does not fall back to another decoder.

Plugins are native-host-only. No plugin metadata, module bytes, parser state,
or source-format detail enters the frontend `DataPlane` renderer or a baked
snapshot. Snapshots contain only the existing session state and selected
decimated tiles.

## Required tests

The host test suite must include a valid multi-batch module and hostile modules
that produce each of the following:

- unsorted, non-finite, or missing time values;
- mismatched column lengths or a row count that changes between batches;
- duplicate names after normalization;
- control characters or a one-megabyte signal name;
- a batch larger than the configured limit or more samples than declared;
- a module that never returns, allocates without bound, or ignores cancellation;
- a module that fails after emitting valid-looking batches.

Every case must fail the file and assert that no source, signal, cache entry,
or partial session reference was committed. Tests must also assert that a
changed module digest misses the old cache entry and that an unavailable
registered module produces an actionable restore error.

## Compatibility review

The plugin host belongs in `scope-core::ingest`; it must not depend on the
Tauri shell or frontend state, preserving ADR 0002. Decode stays off the store
lock and commits through the host-side transaction described by ADR 0009 and
ADR 0026. Provider selection, stable ids, and cache ABI remain the registry
contract from ADR 0033. This spec adds no protocol or snapshot capability.

The implementation requires a separate ADR for the chosen wasmtime/WIT
dependency versions, registration UI, and resource-limit defaults. Until that
ADR and its tests land, SignalScope supports built-in providers and declarative
container recipes only.
