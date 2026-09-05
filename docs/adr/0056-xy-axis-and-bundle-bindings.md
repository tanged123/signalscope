# ADR 0056: XY axis and bundle bindings

- Status: Accepted
- Date: 2026-09-05
- Amends: [ADR 0052](0052-typed-plot-families-and-explicit-x-line2d.md)

## Context

A guessed CSV time column disappeared from the signal catalog. The X picker
only offered existing Y signals, and one shared X could not describe curves
from multiple runs. A user must be able to select either axis independently,
including plotting each run's Y against that run's X.

## Decision

CSV retains every numeric column, including detected time. Only recognized,
finite time headers select the timebase; otherwise row index is the anchor.
The CSV provider cache ABI changes so cached imports cannot hide the column.
Time sorting continues to permute complete rows together.

The workspace owns a durable X binding: linked time, one signal, or a bundle
of explicit signal references. A single X broadcasts to every Y. Bundle X
matches each Y by source key, with exactly one X per source. Missing and
ambiguous matches are errors, never an implicit Cartesian product. X can also
be Y. Exact timebase validation remains in the native paired reducer.

The axis picker owns search, signal/channel-bundle choices, named-set choices,
and dismissal. Y named-set choices retain the set ID so query membership and
later selector edits remain live; X choices capture explicit references.
It uses catalog values and mutation callbacks. Both axes have
keyboard-accessible controls. Bundles are captured as explicit references so
their membership survives save and offline export.

The presentation controller queries existing typed paired endpoints per X
group and publishes the complete panel atomically. Per-series coordinates
retain each group's anchors and X values without interpolation or independent
decimation. Retention remains one overview and one detail per panel; budget
accounting includes every group's coordinate columns. Existing generation,
abort, invalidation and chart-host cleanup apply to the whole publication.
Snapshot preparation uses the same source-key pairing rule and captures every
group through the existing paired payload contract. No HTTP/binary version
changes. Session version 30 adds the bundle variant; version 29 migrates with
unchanged bindings, and older readers reject the new version clearly.

## Alternatives and tradeoffs

One panel per pair would avoid multi-coordinate presentation, but would prevent
overlaid bundle comparisons. Pairing by array position is unstable across
imports. Source-key matching suits run bundles and rejects ambiguity explicitly.
Concurrent native request cost is not improved by this change; no combination
cache or interpolation policy is introduced.

## Validation

CSV tests cover retained time, false monotonic candidates and row alignment.
Binding tests cover broadcast, source matching, missing/ambiguous members and
X equal to Y. Presentation tests cover distinct coordinates, atomic failures,
and retained resource counts. Session and snapshot tests cover migration and
captured bundle pairs. UI tests cover selecting unplotted X and bundles with
keyboard/search paths. The cross-layer CI script is the completion gate.

## Consequences and implementation status

Implemented in this change. Revisit pairing when a concrete
use case needs an explicit cross-source mapping or resampling. The existing
roadmap's large-window and concurrent paired-query measurements remain open.
