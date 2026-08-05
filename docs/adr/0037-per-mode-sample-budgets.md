# ADR 0037: Per-mode sample budgets

- Status: Accepted
- Date: 2026-08-05

## Context

Sample-mode panels (xy, fft, histogram) shared one 8192-point cap and reduce
by integer stride. At 50M points in a window the stride reaches ~6000 and all
three alias. Time panels are unaffected: the pyramid bounds their density by
pixel width and preserves finite extrema per bin.

## Decision

Sample queries keep stride reduction and gain a per-mode cap of 32768 points,
bounded by a 500k per-panel budget across series. The FFT transform cap rises
to 16384 so the extra input is not discarded.

Per-signal min/max reduction is rejected. `pairSamples` takes an exact path
only when an XY panel's x and y signals share a timebase; stride preserves
that (same raw time array, same decimated times), min/max does not. Min/max
additionally biases histogram tails and breaks the FFT's uniform-sampling
assumption.

Extrema-preserving reduction for XY requires a 2D, panel-level reduction over
one shared index set across the panel's x and y signals. It is deferred.

## Consequences

XY, FFT, and histogram resolve four times more detail per query at roughly
1.3 MB of JSON per series. Panels with many series fall back toward the
legacy cap through the budget rather than multiplying wire cost. Very large
windows still alias; the fix is the deferred 2D reduction, not a larger cap.
