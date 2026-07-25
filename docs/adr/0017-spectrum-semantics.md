# 17. Spectrum semantics

Status: Accepted

## Context

The Final Spec's FFT coverage is one static mock. It fixes the axes —
`frequency (Hz), log` with decade ticks from 1 to 1000, `amplitude (dB)` with
ticks at 0, −20, −40, −60, −80 — the header token `window: visible t`, and a
single 1.4px series-coloured polyline. It specifies no window function, no
transform size, no sample-rate derivation, no dB reference, no averaging, and
no interaction model. The prototype contains no FFT code at all, so there is
nothing to "match exactly" the way the expression engine could be.

Ingest guarantees only that time columns are finite and monotonically
nondecreasing (AGENTS.md). Nothing guarantees uniform sampling, and CSV files
without a time column get a synthesized index timebase.

## Decision

Every choice is made once, here, and implemented in
`frontend/src/app/spectrum.ts`:

- **Input** is the visible time window, matching the header token the spec
  draws. Panning or zooming any linked panel recomputes the spectrum.
- **Grid** is the largest power of two not exceeding the sample count inside
  the window, clamped to [64, 4096]. Below 64 the panel shows nothing rather
  than a meaningless transform; 4096 keeps a recompute inside a frame.
- **Sample rate** is derived from the grid, `(N − 1) / (t1 − t0)`, so
  irregular source timestamps need no special case: resampling defines the
  rate.
- **Resampling** is linear. A non-finite result aborts the whole spectrum;
  transforming across a gap would fabricate spectral content, and this
  codebase already refuses to bridge gaps invisibly (ADR 0003).
- **Detrend** by subtracting the mean, then apply a **Hann** taper — the
  default that costs the least explanation and has no free parameter.
- **Output** is one-sided from bin 1. DC is dropped because the spec's axis
  is logarithmic and cannot show `f = 0`.
- **Amplitude** is normalized to the peak bin, so 0 dB is the peak, floored
  at −120 dB. The mock's 0/−80 range is consistent with this; an absolute
  reference would require a unit convention the spec never states.
- **No averaging.** Welch segmenting trades resolution for variance and
  needs a segment-length control the chrome has no room for. Single
  transform over the visible window is the honest default.
- **Multi-series** panels draw one spectrum per visible series, because the
  spec renders FFT panels with ordinary legend chips rather than the dashed
  axis chips that mark a single-signal mode.

## Consequences

- The spectrum is a presentation-plane computation over a bounded window
  slice (ADR 0015), so a snapshot and the workbench cannot disagree.
- The transform is a hand-written radix-2 Cooley–Tukey. The frontend has
  zero runtime dependencies and the Rust workspace forbids `unsafe_code`;
  adding `rustfft`/`realfft` would also touch `Cargo.lock`, which
  `./scripts/version.sh check` validates as a release manifest. At N ≤ 4096
  the performance argument for a library does not arise.
- Averaging, absolute amplitude units, and alternate windows are additive
  later; each would need a control surface, which is why none ships now.
