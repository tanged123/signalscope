# ADR 0028: Ensemble run-mean envelope

- Status: Superseded by ADR 0030 — ensemble tiles and the band renderer were
  removed; source-local signals and named sets provide the supported grouping.
- Date: 2026-07-30
- Amends: [ADR 0014](0014-envelope-bin-sums.md)

## Context

Pooling sample sums across runs weights dense runs more heavily and measures
within-run variation instead of run-to-run scatter. Source sets may also have
partial membership, distinct time units, dropouts, and explicit alignment.

## Decision

Each display cell first reduces every contributing run to one
overlap-weighted mean. It then computes the minimum, maximum, mean, and
population sigma across those run means with equal run weight.

Bin sums and finite counts are apportioned by time overlap. This is exact only
for uniform in-bin sample spacing, so the band may change with grid width.
Ensemble cells discard run identity and cannot be merged into coarser cells.

Queries fail closed until time alignment is valid and accept at most 64
members. Missing runs reduce opacity through `run_count`; they do not break the
band. Snapshots bake the exact set key, generation, member keys, and query
cells. Baked hosts never widen membership or recompute ensemble statistics.

## Consequences

The band estimates across-run behavior without sample-count bias. Queries
remain bounded by viewport width and member count. Zooming may legitimately
change the approximation, and every resolution must be computed from
member-level bins.
