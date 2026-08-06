# ADR 0037: Per-mode sample budgets

- Status: Accepted (amended 2026-08-06)
- Date: 2026-08-05

## Context

Sample-mode panels (xy, fft, histogram) shared one 8192-point cap and reduce
by integer stride. At 50M points in a window the stride reaches ~6000 and all
three alias. Time panels are unaffected: the pyramid bounds their density by
pixel width and preserves finite extrema per bin.

## Decision

Sample queries keep stride reduction and gain a per-mode cap of 32768 points
per series.

A 500k-point budget bounds the panel's **final merged response** — after
per-series decimation and, for XY, after `mergeSampleResponses` concatenates
the context and detail requests. The per-series cap is therefore the budget
divided by the series count and by the number of requests that merge into the
response (two for XY, one otherwise), capped at the per-mode maximum. There is
no lower floor: a floor would let a 1000-series panel request 8.2M points
against a 500k budget, which is the budget not existing.

The FFT transform cap rises to 16384 so the extra input is not discarded.

Per-signal min/max reduction is rejected. `pairSamples` takes an exact path
only when an XY panel's x and y signals share a timebase; stride preserves
that (same raw time array, same decimated times), min/max does not. Min/max
additionally biases histogram tails and breaks the FFT's uniform-sampling
assumption.

Extrema-preserving reduction for XY requires a 2D, panel-level reduction over
one shared index set across the panel's x and y signals. It is deferred.

## Amendment (2026-08-06, pyramid-backed XY)

The deferral above is superseded for shared-timebase pairs. `query_with_target`
derives each signal's level and bin window from the shared time column and the
target, so existing per-signal pyramid tiles are index-aligned without a 2D
reduction, bin-layout change, or new endpoint. XY now requests visible and
coarse context tiles, pairs each bucket's first/last values in index order,
and lifts the stroke on either signal's gap bit.

Alignment is verified from level, count, and boundary timestamps. A pair that
does not verify falls back to the existing sample pipeline; cross-timebase
pairs therefore retain interpolation. The wire format, 500k sample budget,
and sample caps remain unchanged.

## Consequences

A panel holding a handful of series resolves four times more detail per query,
at roughly 1.3 MB of JSON per series. A panel's merged response now stays
within 500k points regardless of series count, so a 1000-series panel drops to
500 points per series (250 for XY) rather than the 8192 it used to request —
markedly coarser per trace, and markedly less wire and per-frame work at the
scale where individual traces are not distinguishable anyway.

Very large windows still alias; the fix is a reduction that preserves
trajectory extrema, not a larger cap.
