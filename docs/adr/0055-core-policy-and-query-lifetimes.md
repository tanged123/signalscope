# ADR 0055: Core policy and query lifetimes

- Status: Accepted
- Date: 2026-09-05
- Implements: ADR 0054's ownership and validation guidance

## Context

Derived dependency and bundle policy lived in the HTTP host. Time queries held
the shared store mutex during expensive reads. Removing derived spill files on
reset could revoke input still used by an active reader. Frontend invalidation
prevented publication but left fetches and scheduled callbacks running.

## Decision

- `scope-core::derived` owns definitions, dependency checks, resident charges
  and materialization. `DerivedContext` borrows only core storage, pyramids,
  budget and cache location. HTTP handlers validate envelopes and map returned
  IDs to protocol summaries. Prepare fallible values before replacing an old
  derived definition; bundle expansion retains its per-member skipped results.
- Query handlers capture immutable signal/pyramid handles under the store
  mutex, then read, reduce and encode outside it. Pyramid level collections are
  shared immutable arrays. Capture the signal alongside its pyramid because
  signal-backed pyramid columns may be weak references.
- Temporary derived spills have unique paths and shared page-handle ownership.
  The final handle deletes its file. Reset/removal does not revoke readers.
  Persistent ingest caches keep their existing lifecycle. Process crashes can
  still leave temporary files; this is not a crash-recovery mechanism.
- Frontend queries accept optional abort signals. Refresh invalidation aborts
  obsolete fetches while generation checks remain authoritative for publication.
  Clearing cancels timers/frames; disposal prevents new work. Page teardown
  releases presentation hosts before the device, except for persisted pages.
  Already-started Rust blocking tasks are not cancelled by aborting fetch.
- `render/gpu-context.ts` owns terminal device-loss state as well as the shared
  device and frame loop. Loss before application subscription is retained and
  delivered in a microtask after subscription setup; unsubscribe or disposal
  cancels pending delivery. Only owner-initiated disposal suppresses recovery.
  The existing failure callback and shell recovery path remain the consumers;
  there is no protocol or session change. Unit tests cover early loss and
  cancellation, and a browser test injects loss before application startup.
- Command metadata and series-inspector construction have independent owners
  with values/callbacks, not an `AppShell` or `PanelView` interface. Panel menus
  own document listeners, keyboard navigation, dismissal and focus return.

## Alternatives and tradeoffs

Keeping work under the mutex simplifies lifetime management but serializes
queries with mutations. Cloned handles allow shorter lock scope without a
store framework or crate split. Unique temporary files give up content-based
spill deduplication so independent producers cannot delete each other's input.
Abort signals reduce obsolete frontend work but do not prove bounded server
memory. No new admission policy or paired-query cache is justified by this
change; complete workload measurements remain roadmap work.

## Compatibility and validation

There is no wire or durable schema change. Live and baked presentation still
share one contract; offline mutation ports remain absent. Shared
`session-parser-cases.json` cases run through Rust `session::from_json` and
TypeScript `parseBakedSession`, covering variants, optional annotation defaults,
invalid input and unsupported versions. The Rust parser explicitly rejects a
time axis carrying a signal reference, which Serde's tagged unit variant had
silently ignored despite the declared schema.

Core derived tests cover dependency guards, bundle re-expansion, failed-spill
replacement and removal with active readers. Server query tests retain inputs
through reset and verify cleanup after the last reader. Controller/transport
tests cover aborted fetches, late completion, clear/reuse and disposal. Menu,
inspector and shell tests cover action dispatch, keyboard dismissal and resource
release. The frontend gate tests effective import rules with allowed/forbidden
examples. Full cross-layer validation runs in CI; do not equate these focused
tests with performance measurements.

## Consequences and implementation status

The above code is implemented in this PR. The remaining legend console, shell
action composition and interleaved stylesheet are not fully decomposed; the
size ratchet still applies. Revisit server admission/cancellation after measuring
wide, gap-heavy and concurrent requests, including timebase comparison and peak
in-flight memory. The roadmap owns that outstanding evidence.
