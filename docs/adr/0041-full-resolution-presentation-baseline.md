# ADR 0041: Full-resolution presentation baseline

- Status: Accepted
- Date: 2026-08-16
- Supersedes: The live presentation reduction portions of ADRs 0036 and 0037, and the density-preservation portion of ADR 0039

## Context

Live rendering reduced source data according to viewport, series, memory, and
sample budgets. That made large traces fast but could change the visible
trajectory and alias XY, FFT, and histogram inputs. The first correctness
baseline must establish native-resolution behavior before further performance
work.

## Decision

Every live panel and window uses full-resolution source data. Time queries
return logical pyramid level zero; sample queries return contiguous windows
with stride one. For live requests, display width, series count, and
compatibility fields such as `pixel_width`, `max_total_bins`, and `max_points`
do not select reduced data.
Histogram aggregation remains the plot's mathematical operation, and FFT
consumes its complete selected window without an artificial input ceiling.

`HttpPlane` and `BakedPlane` implement the same live behavior. Allocation,
transport, renderer, or transform failures surface through existing error
paths; live rendering does not silently retry with reduced data. The larger
raw transfers and their resource costs are therefore visible to users.

Explicit HTML and CSV exports remain governed by ADRs 0024 and 0025. Their
preview, standard, high, and full fidelity choices, range controls, estimates,
warnings, and size handling are unchanged; positive export limits continue to
select the user's requested fidelity. Export fidelity never changes live
rendering resolution.

The ingest pyramid and coarse cached levels remain temporarily for explicit
reduced-fidelity exports and follow-up work. No live workbench presentation
path consumes a coarse level. The existing binary and sample protocol shapes
remain stable, with the ignored reduction fields retained for compatibility.

## Consequences

The two presentation hosts stay behaviorally aligned, and plots show native
samples before a later measured optimization. Large datasets may require more
transport, memory, and GPU capacity; failures are visible rather than hidden
by LOD. ADRs 0024 and 0025 remain authoritative for exports. This record does
not change the pyramid's gap, extrema, identifier, or protocol-version
invariants.
