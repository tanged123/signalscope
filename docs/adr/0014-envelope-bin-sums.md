# 14. Envelope bins carry finite sums for visible statistics

Status: Accepted

Amends [ADR 0003](0003-min-max-tile-pyramid.md).

## Context

Phase 2 shows per-series min/max/μ/rms of the visible region. Bins carried
first/last/min/max/sample_count/has_gap; mean and RMS were not derivable at
any zoom level, and scanning raw arrays per stats refresh would break the
pyramid's bounded-cost premise — and be impossible in the snapshot host,
which holds only bins.

## Decision

`EnvelopeBin` gains `sum` (Σ of finite values), `sum_sq` (Σ v²), and
`finite_count`. Leaves derive them from the sample; parents add them, like
the other merge invariants. All-NaN bins carry `0.0 / 0.0 / 0`, not null.
Statistics are computed in the presentation plane from the bins actually
displayed: exact at level 0, bin-granular at window edges when zoomed out.
The strip therefore always describes what is drawn.

Protocol version moves to 3; sidecar bin records grow to 88 bytes under
`CACHE_VERSION` 2, so existing sidecars degrade to cache misses and rebuild.

## Consequences

μ/rms are exact for any fully covered bin range in O(bins) on both hosts.
Sidecar files grow ~37% per level. No raw-array scan enters the renderer.
