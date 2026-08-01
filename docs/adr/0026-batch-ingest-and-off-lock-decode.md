# ADR 0026: Batch ingest and off-lock decode

- Status: Accepted
- Date: 2026-07-30
- Amends: [ADR 0009](0009-ingest-jobs-and-progress.md)

## Context

Single-file jobs held the combined store/pyramid mutex through decode, cache
IO, and pyramid construction. Large imports blocked queries, multiplied memory
without admission control, and could not represent partial success.

## Decision

`Decoder` returns owned `DecodedSource` columns. Decode, cache IO, and pyramid
construction run without the host store lock. A host `CommitSink` takes the
lock only to register one source and its prepared pyramids atomically.

One batch has bounded worker concurrency and memory-weighted working/resident
admission. Its queue contains only file identity metadata. Each file settles
independently; one failure does not roll back committed siblings. Duplicate
canonical paths join one single flight.

The state machine is:

`running → done | partial | failed | cancelled`

Polling returns aggregate counts and at most 16 recent failures. Full file
status is paged. Terminal jobs expire and may be released early.

CSV decoding is streaming and cancellation-aware. MCAP remains whole-file
until the out-of-core phase.

## Consequences

Queries no longer wait for file decode or pyramid construction. The retired
ADR 0009 consequence that held the store mutex for a job no longer applies.
Committed files survive sibling failure and cancellation. Hosts remain
responsible for the short atomic commit.
