# ADR 0024: Snapshot manifest and export budget

- Status: Accepted
- Date: 2026-07-29

## Decision

The protocol schema owns `SnapshotManifest`, whose envelope protocol version
is the manifest version. It contains the session as an opaque JSON string and
signals with positional pyramid levels. The session remains opaque because
its independent schema and migration code live in `scope-core`.

Level index zero in a baked signal is its finest included level. Visible
exports include panel-referenced signals over the union of effective panel
windows, beginning with the first level containing at most 2,048 in-window
bins. Sparse windows and signals used by non-time panels retain logical level
zero. All-loaded exports include every signal and level.

Export clears `source_paths` to avoid leaking inert local paths. One
`scope-core::snapshot` module serves the Tauri commands and the internal
`scope-bake` CLI behind `./scripts/export.sh`.

## Consequences

Snapshots share the generated protocol boundary and remain deterministic for
identical inputs. Visible exports trade fine zoom depth for bounded size;
all-loaded exports retain full fidelity. New panel modes must decide whether
their sample semantics require level zero.
