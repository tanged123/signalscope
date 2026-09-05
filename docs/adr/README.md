# Architecture decision records

ADRs are the durable architecture record. A later ADR amends or supersedes an
earlier decision; the historical file stays in place so old sessions and
implementation choices remain explainable.

ADRs record _why_. For _where code goes_ and _what to reuse_, read
[architecture.md](../architecture.md).

Use the [short ADR template](template.md) for changes to boundaries,
compatibility, reduction semantics, or resource policy. Local implementation
details do not need a separate record. [ADR 0054](0054-evidence-backed-architecture-guidance.md)
defines how to distinguish current implementation, accepted decisions, and
pending work. The [roadmap](../implementation-roadmap.md) owns implementation
progress; amend earlier records with explicit links when their guidance changes.

## Current decisions

1. [Product shape and two-host frontend](0001-product-shape-and-two-host-frontend.md)
2. [Layer boundaries](0002-layer-boundaries.md) (host updated by 0038/0049; module guidance amended by 0053/0054)
3. [Min/max tile pyramid](0003-min-max-tile-pyramid.md)
4. [Versioned protocol and code generation](0004-versioned-protocol-and-codegen.md)
5. [Session schema versioning](0005-session-schema-versioning.md)
6. [Linked-time model](0006-linked-time-model.md)
7. [Snapshot injection](0007-snapshot-injection.md)
8. [Expression evaluation layer](0008-expression-evaluation-layer.md)
9. [Ingest jobs and progress](0009-ingest-jobs-and-progress.md) (amended by 0026)
10. [Workspace tabs and chrome hierarchy](0010-workspace-tabs-and-chrome-hierarchy.md) (partly superseded by 0020)
11. [Series palette and reserved amber](0011-series-palette-and-reserved-amber.md)
12. [Envelope-bin sums](0014-envelope-bin-sums.md)
13. [Bounded window sample requests](0015-window-sample-requests.md) (narrowed by 0043)
14. [Three-strip chrome and hidden application menu](0020-three-strip-chrome-and-hidden-application-menu.md)
15. [Desktop-only input](0021-desktop-only-input.md)
16. [Durable session persistence](0022-durable-session-persistence.md) (restore ordering amended by 0027)
17. [Global preferences file](0023-global-preferences-file.md)
18. [Snapshot manifest and export budget](0024-snapshot-manifest-and-export-budget.md)
19. [Orthogonal export range and fidelity](0025-orthogonal-export-range-and-fidelity.md)
20. [Batch ingest and off-lock decode](0026-batch-ingest-and-off-lock-decode.md)
21. [Durable source identity and restore reconciliation](0027-durable-source-identity-and-restore-reconciliation.md) (legacy reconciliation retired by 0050)
22. [Out-of-core columns, pyramids, and ensembles](0029-out-of-core-storage.md)
23. [Source-local channel identity](0030-source-local-channel-identity.md)
24. [Remove source alignment metadata](0031-remove-source-alignment.md)
25. [Forward native window drag-drop events](0032-drag-drop-event-forwarding.md)
26. [Runtime format provider registry](0033-format-provider-registry.md)
27. [Declarative container recipes](0034-declarative-container-recipes.md)
28. [Benchmark harness and performance floors](0035-benchmark-harness-and-performance-floors.md)
29. [Binary tile transport and render path](0036-binary-tile-transport-and-render-path.md)
30. [Browser-only host](0038-browser-only-host.md)
31. [ChartGPU time-series renderer](0039-chartgpu-time-series-renderer.md) (delivery amended by 0040; viewport amended by 0045)
32. [ChartGPU submodule delivery](0040-chartgpu-submodule-delivery.md)
33. [Full-resolution presentation baseline](0041-full-resolution-presentation-baseline.md) (amended by 0044)
34. [Padded render feed and windowed presentation math](0042-padded-render-feed.md)
35. [Time-only presentation and a single plotter](0043-time-only-presentation.md) (explicit-X and typed families added by 0052)
36. [Adaptive-resolution presentation](0044-adaptive-resolution-presentation.md)
37. [Constant-work ChartGPU viewport updates](0045-constant-work-chart-viewport.md)
38. [Uniform presentation admission](0046-uniform-presentation-admission.md)
39. [Overview/detail tile retention](0047-overview-detail-tile-retention.md)
40. [Legend console and serialized overlay state](0048-legend-console.md)
41. [Electron distribution shell](0049-electron-distribution-shell.md)
42. [Retire obsolete compatibility seams](0050-retire-obsolete-compatibility-seams.md)
43. [Style cascade, legend analysis, and inspection state](0051-style-cascade-and-legend-statistics.md)
44. [Typed plot families and the explicit-X Line2D foundation](0052-typed-plot-families-and-explicit-x-line2d.md)
45. [Module boundaries and shared primitives](0053-module-boundaries-and-shared-primitives.md) (extraction and size-policy interpretation clarified by 0054)
46. [Evidence-backed architecture guidance](0054-evidence-backed-architecture-guidance.md)
47. [Core policy and query lifetimes](0055-core-policy-and-query-lifetimes.md)

48. [XY axis and bundle bindings](0056-xy-axis-and-bundle-bindings.md)

## Superseded decisions

These records are retained for history and are not implementation guidance:

- [Panel command routing and bounded legends](0012-panel-command-routing-and-bounded-legends.md)
  and [responsive panel legends](0013-responsive-panel-legends.md) — superseded
  by ADR 0048.
- [Sequential colormap](0016-sequential-colormap.md), [spectrum semantics](0017-spectrum-semantics.md),
  [histogram semantics](0018-histogram-semantics.md), [prepared plot capabilities](0019-prepared-plot-capabilities.md),
  and [per-mode sample budgets](0037-per-mode-sample-budgets.md) — superseded by ADR 0043.
- [Ensemble run-mean envelope](0028-ensemble-run-mean-envelope.md) — the
  ensemble band implementation was removed; source-local signals and named
  sets are governed by ADR 0030.

Read the current records above first. Do not use superseded ADRs, design
explorations, or historical plans as requirements for new work.
