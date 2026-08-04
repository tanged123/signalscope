# ADR 0036: Binary tile transport and render path

- Status: Accepted
- Date: 2026-08-04

## Decision

Bulk native tile responses use a versioned little-endian binary columnar
framing. The native JSON tile command is removed; `query_tiles_bin` performs
the query in `spawn_blocking` and returns raw IPC bytes. `BakedPlane` keeps the
JSON snapshot manifest, applies the same per-request bin budget, and converts
its result to the same typed column model before rendering.

The binary response layout is:

| Part            | Encoding                                                                                                                            |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Response header | `u32 magic` (`0x4254_5353`), `u32 protocol_version`, `u32 series_count`, `u32 reserved`, all little-endian                          |
| Series header   | `u64 signal_id`, `u32 level`, `u32 bin_count`, `u16 path_bytes`, `u16 unit_bytes` (`0xffff` means null), `u32 reserved`             |
| Series names    | UTF-8 signal path and optional unit, padded to an 8-byte boundary                                                                   |
| Bin columns     | `f64` t0, t1, first, last, min, max, sum, sum_sq; `u32` sample_count and finite_count; `u8` flags; series payload padded to 8 bytes |

The five flag bits identify first, last, finite minimum, finite maximum, and
gap values. Missing optional floating-point values are encoded as NaN in their
column and remain governed by the flags. TypeScript decodes the columns as
typed-array views without per-bin objects; signal IDs cross the boundary as
exact strings.

Requests may carry a total bin budget. The presentation plane sends 250,000
bins for a multi-series tile request; each host assigns
`max(64, floor(budget / signal_count))` to a series, and pyramid selection
clamps its `2 * pixel_width` target to that share. This keeps density bounded
while preserving pyramid extrema and gap semantics.

The core page cache stores fixed-size pages and updates residency counters
incrementally. The frontend requests aligned, padded time windows, slices
cached typed arrays with zero-copy subarray views, and invalidates the cache
when the signal catalog changes or its request identity no longer matches.

Canvas2D time strokes use one plot clip per frame, bevel joins, diffed stroke
state, and per-column vertex skipping: an envelope emits entry, only extrema
that differ from both endpoints, and exit. Dense tiles merge bins into pixel
columns while retaining first, last, min, max, and gap state. Geometry is
cached in `Path2D` by typed-column identity and projection key so style-only
redraws restroke existing paths. `has_gap` lifts the pen; gaps are not
represented by uPlot-style inverse clip paths.

## Consequences

Native tile traffic no longer pays JSON object allocation or serialization
costs, and both hosts share the same bounded columnar presentation contract.
The binary codec is an API and therefore remains versioned with the protocol;
unknown versions fail before partial decoding. Padded windows trade some
overfetch for request elision, while typed-array slices and weakly held paths
avoid copying and retainment of obsolete responses.

GPU rendering, density or aggregate textures for larger spaghetti panels,
binary snapshot manifests, and an HTTP/WebSocket data plane remain deferred.
