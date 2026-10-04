# ADR 0068: Binary snapshot payload

- Status: Accepted
- Date: 2026-10-03
- Amends: [ADR 0024](0024-snapshot-manifest-and-export-budget.md) level wire
  format; [ADR 0025](0025-orthogonal-export-range-and-fidelity.md) size
  estimate

## Context

Snapshots stored every pyramid bin as an eleven-field JSON object, about
200 bytes per bin and roughly 400 bytes per raw sample once every level is
included. A 1,000-run Monte Carlo set of modest length exceeded what a browser
or GitHub Pages (100 MB per file) can serve. The data must stay exact:
exports reduce detail only through the explicit fidelity ladder.

## Decision

`SnapshotManifest.payload` is one base64 deflate-raw stream of little-endian
columns. Each column is byte-shuffled by element width and deduplicated by
content (kind plus bytes). The decompressed stream ends with the column table
`[kind: u8; n] [element count: u32; n] [n: u32]` (0 = f64, 1 = u32, 2 = u8);
offsets follow from table order. The JSON keeps the session, preferences,
summaries, Line2D and histogram metadata, and refers to columns by index.

`BakedSignal.levels` keeps the planned levels unchanged. A level is encoded as
`samples` (`time`, `value`) when every bin is exactly the single-sample bin
`pyramid::synthesize` derives from that pair; otherwise it stores all eleven
`BinLevel` columns, with absent extrema as NaN. Line2D `anchor`, `x` and `ys`
are f64 columns with non-finite values stored as NaN. Histogram captures stay
JSON.

`scope-core::snapshot::payload` owns encoding. Signals and lines are encoded in
id order, so identical inputs produce identical bytes. In the browser,
`decodeSnapshot` validates the version, stream, column table, kinds and lengths
before returning; any failure rejects the whole snapshot. `BakedPlane` holds
typed columns and expands sample levels on first use. Protocol version 20
rejects version 19 snapshots without migration.

## Alternatives and tradeoffs

Dropping intermediate levels or summary columns would shrink files further but
silently change what a snapshot can show, so it was rejected. Rebuilding
pyramids in the browser would duplicate core reduction logic. XOR-delta coding
and the maximum deflate level each saved under 5% on the demo corpus and were
not adopted. Base64 adds a third on disk; gzip transport removes most of it.

## Validation

Rust tests round-trip every pyramid level bit for bit, including NaN, ±Inf,
-0.0 and gap bins, and keep the bake byte-stable.
`protocol/testdata/snapshot-payload-conformance.json` is written by Rust and
decoded by `snapshot-payload.test.ts`, which also checks tile and sample parity
with wire-built levels and rejects damaged payloads. The hosted demo (1,000
runs × 5 channels × 321 samples plus Line2D pairs) bakes to 62.6 MB
(42 MB gzip) and loads without errors in headless Chromium; hardware load
time is not yet measured.

## Consequences and implementation status

Implemented. The export estimate counts uncompressed columns, so real files
are usually several times smaller. Exports beyond
browser limits remain the user's choice of signals, range and fidelity.
