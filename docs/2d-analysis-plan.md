# Incremental 2D analysis plan

This is the proposed scope for adding analysis views one at a time, requested
on 2026-09-16. It is not an accepted architecture decision or evidence of
implemented behavior. The [roadmap](implementation-roadmap.md) owns progress
and completion criteria. Refine each increment against current code, record
its boundary decisions in an ADR, then implement and validate that increment.
Do not scaffold the later features in advance.

## Starting point

SignalScope currently renders Line2D and sampled Scatter2D through one
ChartHost per panel. Explicit signal-X bindings already cover trajectories,
phase portraits, and Lissajous figures when signals share an exact timebase.
Rust's `compute` and expression evaluator already provide `gradient`,
`cumtrapz`, and `movmean`. They do not yet provide spectrum, distribution,
or correlation results with their own coordinate bindings.

[ADR 0052](adr/0052-typed-plot-families-and-explicit-x-line2d.md) permits
computed frequency results to use Line2D rendering, but requires a suitable
computed-result binding and typed data contract.
[ADR 0066](adr/0066-scatter-panels-and-creation.md) establishes current panel
creation and sampled scatter. Neither makes sampled plot rows a statistical
representation of the source distribution.

Use the [architecture guide](architecture.md) for owners and shared primitives,
and the [design handoff](Signal%20Scope%20UI%20Design%20Pass/design_handoff_signalscope_ui/README.md)
and its Final Spec for visuals and interaction, with accepted amendments.
Historical spectrum/histogram ADRs 0017/0018 are superseded; their defaults
are not requirements for this work.

## Priority and delivery order

Usefulness is relative to engineering telemetry; effort includes computation,
contracts, interaction, persistence, and offline capture, not just drawing.
Estimates are qualitative and have not been benchmarked.

| Usefulness/effort rank | Addition                                  | Effort      | Delivery increment |
| ---------------------- | ----------------------------------------- | ----------- | ------------------ |
| 1                      | Histogram                                 | Low–medium  | 1                  |
| 2                      | Spectrum: amplitude, then Welch PSD       | Medium      | 3a, then 3b        |
| 3                      | Cumulative distribution and exceedance    | Low–medium  | 2                  |
| 4                      | Rolling mean, RMS, and standard deviation | Low–medium  | 4                  |
| 5                      | Autocorrelation                           | Medium      | 5                  |
| 6                      | Cross-correlation                         | Medium–high | 6                  |
| 7                      | Lag plot                                  | Low–medium  | 7                  |
| 8                      | Box-and-whisker comparison                | Medium      | 8                  |

Ship CDF immediately after Histogram to reuse proven distribution semantics;
ship PSD after amplitude spectrum to reuse validated spectral input handling.
Rolling statistics and lag plots can move earlier if their users need them.
The existing-transform conveniences below are a separate small increment.

## Contracts to settle in the first consuming increment

These are proposed implementation constraints. Record concrete schema shapes,
limits, algorithms, and compatibility choices in the consuming feature's ADR.

### Source window and numerical inputs

- Analysis uses a source-time interval, initially the linked workspace window.
  Offer an explicit frozen interval when needed to compare windows. Retain the
  source interval separately from the analysis plot's X/Y camera.
- Histogram, CDF, Spectrum, correlation, and box plots have local value,
  frequency, lag, or category coordinates. Panning their camera must not alter
  the source interval or publish those coordinates as linked time. Rolling
  series retain normal linked-time behavior; lag observations retain source time.
- Compute on source samples in Rust, then reduce the result for display.
  Neither extrema-envelope tiles nor sampled scatter rows are valid inputs for
  exact distribution counts or spectral analysis. Source windows for aggregate
  statistics exclude the extra neighbors used to draw time-series strokes.
- Define interval endpoint inclusion once, including duplicate timestamps.
  Distribution views initially describe samples, not time spent at a value;
  irregular sampling does not imply duration weighting.
- Exclude nonfinite values from distributions and report excluded counts.
  Spectral and initial correlation operations require finite, uninterrupted,
  uniformly sampled data. Specify sample-spacing tolerance, timestamp units,
  minimum lengths, and explicit failures. Never drop invalid spectral samples
  and silently close the resulting time gaps.
- Exact aggregation may scan a large window while returning a small result.
  Budget scan concurrency, sort/FFT scratch space, resident and spilled input,
  response storage, and GPU feeds separately. If a workload exceeds an admitted
  bound, explain the limit; do not silently subsample or truncate the interval.

### Owners, publication, and cleanup

| Concern                        | Proposed owner and boundary                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Definitions and saved settings | WorkspaceModel owns generated session state: source identities, interval selection, operation settings, and local axis state.              |
| Numerical invariants           | Cohesive modules under `scope-core::compute`; consume fallible column/window access without HTTP or UI dependencies.                       |
| Derived time-series lifetime   | Existing `scope-core::derived` ownership, dependency validation, materialization, and spill cleanup.                                       |
| Analysis reads                 | Typed protocol requests/results and thin server handlers; capture immutable source handles under the store lock, compute outside it.       |
| Scheduling and publication     | Application presentation controller owns request identity, cancellation, admission, stale-result rejection, and atomic result replacement. |
| Presentation                   | Family preparation supplies domain-specific inspection and render inputs; ChartHost owns GPU publication and disposal.                     |
| Offline results                | Core snapshot preparation captures analysis data and settings; BakedPlane exposes the same presentation contract as HttpPlane.             |

Include source identity/revision, operation settings, interval, and relevant
quality parameters in request identity. Window edits, definition replacement,
binding removal, reset, and panel disposal invalidate affected work. Retain a
previous covering result while replacement is pending, with a visible stale
state; never label an older window's result as current. Failed replacement
must remain an explicit failure. Release old CPU/GPU buffers on replacement
or teardown, and temporary spills after the last reader releases ownership.

Abort fetches and reject obsolete completions. Existing fetch cancellation
does not cancel an already running Rust blocking task: establish measured
admission and cooperative cancellation where the new operation needs it.
Do not create an unbounded cache of analysis parameter combinations. Reuse
existing retention policy where it fits; document any family-specific change.

### UI, schemas, and offline behavior

- Expose only completed views in panel creation. Reuse compact Plot/Style/
  Readouts menus and existing keyboard-accessible selection patterns. Every
  view has labeled axes, units, source-window context, visible series identity,
  and loading, empty, invalid-input, and failure states.
- Choose the smallest honest content representation per increment. A new
  analysis view can reuse Line2D geometry without pretending its frequency or
  probability coordinate is a stored signal or source timestamp. Do not add a
  universal analysis registry or restore the old panel-mode stack.
- Define cursor, statistics, annotation anchors, and deltas in the result's
  domain. Do not fabricate per-point time anchors for aggregate results or
  revive annotation-domain fields removed by ADR 0050; propose the minimal
  typed extension and explicit ADR amendment if existing state cannot fit.
- Add schemas only for the current increment, regenerate with `pnpm codegen`,
  and validate inputs at native and baked boundaries. Review protocol,
  session, preferences, and snapshot version domains independently. Add
  defaults or migrations as appropriate; reject unsupported versions before
  partial restore. Preserve exact wire identifiers.
- Initially bake computed results and their provenance/settings. Offline
  camera changes and inspection remain available; changing a source interval
  or computation parameter requires captured inputs sufficient for that exact
  operation. Disable unavailable recomputation with a clear explanation.
  Never reconstruct analysis from decimated time tiles. Define the captured
  interval for both visible-window and all-loaded export modes explicitly.
- HTML capture includes labels, appearance, annotations, and analysis fidelity;
  make no network requests, preserve the exact injection slot and script-data
  escaping, and stay within the export budget. PNG includes the displayed axes
  and context. CSV exports the actual result coordinates and units.

## Increment 1: Histogram

Implementation and remaining acceptance work are tracked in
[ADR 0067](adr/0067-exact-histogram-panels.md#consequences-and-implementation-status)
and the [roadmap](implementation-roadmap.md#planned-2d-analysis-additions).

**Outcome:** compare how signal values are distributed over the selected
source-time interval, with trustworthy counts and readable overlapping series.

Initial scope:

- Equal-width bins with explicit bin-count control; propose 32 as the initial
  default. Deterministic automatic bin selection can follow after quantile
  infrastructure exists. Do not require sorting merely to choose initial bins.
- Share edges across visible series with compatible units. Do not implicitly
  convert units or mix unlike quantities on one value axis. Define a finite,
  nonzero range for constant-valued inputs and stable edge arithmetic at large
  magnitudes. Interior bins are left-closed/right-open; include the final edge.
- X is source value with unit; Y initially is exact sample count. Draw step
  outlines through line geometry. Cursor reports interval and count per series.
  Visibility changes that affect shared edges trigger one atomic rebin.
- Anchor annotations by source value and resolve them to the current bin;
  retain provenance when the source interval or edges change. Deltas are value
  and count differences, never time differences.

Implement a paged range/count reduction, typed edges/counts result with finite
and excluded totals, histogram preparation, controls, and native/baked capture.
Counts remain exact through the wire; document how large integers convert to
render coordinates without losing exact textual readouts.

Acceptance: counts sum to the finite source cardinality; fixtures cover every
edge, ties, constants, negative values, empty windows, nonfinite values, and
overlaid series. Panning the histogram does not rebin; source-window changes
do. Compare paged and resident inputs. Verify rebinning, cursor/annotations,
rapid-window stale completion, source deletion, saved restore, and offline
counts independently of display density.

Later options: probability and density normalization, explicit edges, and
automatic bin rules. Probability heights sum to one; density integrates to
one by bin width and carries inverse-value units.

## Increment 2: Cumulative distribution and exceedance

**Outcome:** read the fraction of samples below or above a threshold and
compare percentiles without dependence on histogram bin choice.

Compute an empirical CDF from finite source values, grouping ties. Define
`F(x) = count(value <= x) / N`; exceedance is `P(value > x) = 1 - F(x)`.
X is value with unit and Y is fraction or percent. Use right-continuous step
geometry; label sample weighting explicitly for irregularly sampled sources.
Provide CDF/exceedance selection and threshold/percentile inspection.

Use exact sorted values for admitted windows. Before supporting larger ones,
choose bounded external sorting or a separately labeled approximation with
an error contract; never claim exact percentiles from decimated display points.
Keep queryable probability/quantile information separate from display reduction
if required. Define quantiles as the generalized inverse of the empirical CDF;
later box-plot interpolation may have a different, explicitly named convention.

Acceptance: monotonicity, range [0,1], endpoints, ties, constants, empty input,
and `F(x) + exceedance(x) = 1`; known threshold counts and inverse-CDF fixtures.
Changing display resolution cannot change reported exact statistics. Include
unit compatibility, native/baked parity, and staircase picking at jumps.

## Increment 3a: Amplitude spectrum

**Outcome:** identify tones and harmonics in a selected signal interval.

Start with real, finite, uniformly sampled, gap-free inputs. Propose mean
removal and a periodic Hann window as defaults, with an explicit rectangular
window option for comparison. Show window choice, detrending, sample rate,
sample count, and analyzed duration. Validate these before allocating FFT
scratch space. Narrowing the requested interval is explicit; no silent cap.

Return one-sided frequency coordinates in Hz and peak-amplitude values in the
source unit. Normalize by window coherent gain; double positive-frequency
interior bins, but not DC or the even-length Nyquist bin. Specify odd-length
behavior, short-input failure, DC behavior when mean removal is enabled, and
the distinction between bin spacing and resolving nearby tones. Zero padding
does not increase physical frequency resolution.

Use the existing Cartesian line host with a computed frequency binding.
Support linear/log frequency and linear amplitude; to match the Final Spec's
dB view, define `20 log10(amplitude/reference)` with a visible reference and
unit. A dB-valued Y axis is linear. Define zero/floor handling explicitly;
omit DC from log-X display without removing it from numerical results.
Annotations anchor frequency and record the analyzed interval/settings.

Acceptance: analytical constant, impulse, coherent sine, odd/even FFT length,
Nyquist, and two-tone fixtures; off-bin leakage/window comparisons; rejection
of gaps, nonfinite values, duplicate times, invalid rates, and excessive
spacing jitter. Check units, dB references, source-window refresh, and capture.
Validate against an independent direct DFT on small arrays; measure realistic
wide windows, concurrent panels, peak scratch memory, and obsolete requests.

## Increment 3b: Welch power spectral density

**Outcome:** compare broadband noise and spectral power using the Spectrum
panel with an explicit amplitude/PSD calculation selector.

Reuse spectral input validation and frequency rendering. Add segment length
and overlap; propose periodic Hann, per-segment mean removal, 50% overlap, and
arithmetic averaging. Choose and serialize the initial segment length in this
increment based on representative recordings; show actual length and number
of complete segments. Reject invalid overlap or insufficient input. Specify
the trailing incomplete-segment policy instead of silently padding it.

Normalize by sample rate and window energy, producing source-unit squared/Hz.
One-sided doubling follows the DC/Nyquist rules. PSD dB uses `10 log10` with a
visible power-density reference. Keep amplitude and PSD units/settings distinct.

Acceptance: integrated PSD matches the corresponding window-weighted,
detrended segment power under the declared discrete normalization; seeded
noise agrees with independent expected power within a stated tolerance.
Check segment accounting, overlap, zero signal, scaling under multiplied input,
odd/even lengths, and native/baked readouts. Compare small cases with an
independent reference calculation, not another call to the implementation.

## Increment 4: Rolling statistics

**Outcome:** inspect changing mean, signal strength, and variability on normal
time-series axes, with derived results reusable elsewhere.

Use the existing derived-signal lifecycle and expression surface, initially
with centered odd sample-count windows. Keep the existing `movmean` contract;
it currently skips nonfinite values and shrinks at boundaries. Audit its
window-size cost before reuse at large sizes. Add RMS and population standard
deviation with explicit valid counts, boundary handling, and all-invalid output.
Use stable rolling accumulation; avoid cancellation-prone variance obtained
only by subtracting two large nearly equal moments.

Expose creation through existing formula/series-inspector paths. Preserve the
source timebase and normal Line2D interactions; no separate renderer or panel
family is required. State that sample-count windows are not duration windows
on irregular data. Time-duration/trailing windows are later explicit options.

Acceptance: constants, impulses, ramps, gaps, short signals, boundary windows,
and large-offset/small-variance data. RMS of a constant is its absolute value;
population deviation of a constant is zero. Compare small windows to an
independent two-pass reference. Test dependency removal, failed replacement,
save/restore, spill cleanup, and derived-result capture. Measure scaling in
signal length and window width before promising interactive recomputation.

## Increment 5: Autocorrelation

**Outcome:** inspect repetition and persistence as correlation versus lag.

Initially use the same strict sampling/gap admission as Spectrum, a maximum
lag control, and demeaned normalized autocorrelation. Proposed definition is
`sum(z[i] * z[i+k]) / sum(z[i]^2)` over valid overlapping index pairs, where
`z` is the complete window after mean removal. This uses a fixed denominator;
label the estimator and do not silently switch to overlap normalization.
Zero-variance inputs have undefined correlation and get an explicit state.
X is lag in seconds, Y is dimensionless correlation; retain sample lag in
readouts. Begin with nonnegative lags and no inferential confidence bands.

Use a direct method for small bounded work and FFT acceleration when justified;
zero-pad for linear correlation so the tail cannot wrap around. Derive any
algorithm crossover from measurement. Return lag coordinates through a typed
result and reuse line rendering; local lag inspection never publishes time.

Acceptance: nonconstant input has lag-zero value one, coefficients stay within
[-1,1] within tolerance, known periodic input has expected repeated peaks,
and direct/FFT results agree on independent small cases. Check short inputs,
max-lag validation, zero variance, non-wrapping behavior, cancellation, and
offline inspection.

## Increment 6: Cross-correlation

**Outcome:** estimate delay between two related signals, with clear ordering.

Start with exactly two signals sharing a finite, uniform, gap-free timebase.
Reject incompatible timebases; resampling is a later deliberate feature.
Choose reference A and response B explicitly. Define positive lag as B
occurring later than A: correlate `A[i]` with `B[i+k]`. Display that convention
beside peak-lag readouts. Offer positive and negative lags with a maximum bound.

Propose global mean removal and normalization by the product of complete-window
L2 norms, using overlapping products and zero padding outside the interval.
State that large lags have less overlap. Report the strongest absolute peak
with its signed coefficient; do not imply that every peak proves a causal
delay. Define tie handling deterministically. Constant inputs are undefined.

Reuse tested correlation primitives once both consumers establish the shared
semantics. Save both source identities, ordering, settings, and interval.
Cursor and annotations describe lag/correlation; result CSV includes overlap
count where needed to interpret peaks.

Acceptance: a known delayed pulse peaks at the declared positive lag, swapping
A/B reverses lag, sign inversion reverses coefficient, and proportional
identical nonconstant signals have unit-magnitude zero-lag correlation.
Check constants, unequal lengths/timebases, edge overlap, periodic ties,
direct/FFT agreement, source deletion during work, and offline pair labels.

## Increment 7: Lag plot

**Outcome:** inspect temporal structure by plotting a signal against its past.

Start with an integer sample lag `k >= 1`: X is `y[i-k]`, Y is `y[i]`, and
the observation anchor is source time `t[i]`. Show lag in samples; show seconds
only when uniform timing makes the conversion valid. Require both members of
the pair to fall inside the selected interval; omit pairs with nonfinite
values. Form pairs before selecting display rows, preserving correspondence.

Reuse sampled Scatter2D rendering, point picking, equal-axis scaling, series
identity, and source-time linking. Define a computed pair binding rather than
registering fake source signals. Initially offer per-series colors and optional
anchor-time coloring; arbitrary C requires an explicit row-alignment contract.
Time-duration lag/interpolation and density-preserving rendering are later work.

Acceptance: a ramp gives the expected offset diagonal, a quarter-period lag
of a sine gives the expected circular relation with equal axes, and selected
rows remain real lagged pairs. Check lag bounds, interval edges, gaps,
irregular-time labels, source-time cursor linking, restore, and offline points.

## Increment 8: Box-and-whisker comparison

**Outcome:** compare distributions across channels or runs in compact space.

Reuse finite-value/window semantics and quantile work only where definitions
match. Propose median, Q1, Q3, and whiskers at the most extreme observations
within 1.5 IQR of each hinge. Specify the exact quantile interpolation rule in
the ADR and readout documentation; do not equate interpolated quartiles with
the CDF's generalized inverse without evidence. Return finite/excluded counts,
whiskers, quartiles, and total outlier count.

Use deterministic categorical positions keyed by source/series identity,
readable labels, and source-value units on Y. Draw box outlines, median, and
whiskers with line segments; sampled outlier markers may use points, clearly
labeled with displayed and total counts. Measure combined primitive support
before changing ChartHost; retain one host per plot.

Category navigation, picking, and annotations need explicit semantics rather
than arbitrary numeric ticks. Preserve category ordering across visibility
changes and restore. Support keyboard inspection of each summary statistic;
prevent incompatible units from sharing an unlabeled numeric scale.

Acceptance: independent known quartiles/whiskers, constants, tiny samples,
ties, outliers, all-invalid categories, stable ordering, long labels, and
many-category scrolling/zoom. Verify counts do not change with sampled outlier
display, categories retain identity after removal/reorder, and offline capture
preserves exact summaries and disclosed outlier fidelity.

## Existing-transform conveniences

Audit the existing formula and inspector paths first; implement only missing
discoverability or composition, without adding duplicate operations.

- Derivative and integral: expose current `gradient`/`cumtrapz` behavior clearly,
  including duplicate-time and gap handling, units, and initial integration
  reference. Any numerical correction is a separate change with independent
  fixtures; a shortcut must not silently change an existing expression.
- Phase portrait/Lissajous: provide guidance or a small creation shortcut that
  binds two existing signals to Line2D/Scatter and optionally enables equal
  axes. A signal-versus-derivative portrait composes the existing derived path.
- Validate keyboard creation, generated bindings/expressions, undo/redo, and
  save/restore. Reuse current transform tests when behavior is unchanged.

## Later families

Spectrograms and 2D density heatmaps remain outside these line/point increments.
Revisit them after Spectrum and distribution work: spectrograms need a
time-frequency grid, density plots need count-preserving 2D reduction, and
both need raster/color-scale picking, budgets, and baked grid contracts.
Contours, transfer-function/Bode analysis, and 3D require separate proposals.

## Completion gate for each increment

1. Refine only the next feature's controls and numerical defaults. Record its
   contract, ownership, compatibility, reduction, and offline decisions in a
   new/amended ADR using the repository template. Resolve module-size boundaries
   before adding behavior to oversized owners; do not expand the old mode stack.
2. Land the smallest complete path: core calculation, typed API, application
   preparation, renderer integration, UI, persistence, and offline capture.
   Shared primitives are extracted when a concrete consumer requires them.
3. Run focused Rust and TypeScript behavior tests, then schema/frontend checks.
   Cover stale completion, partial multi-series failure, removal, cleanup, and
   invalid restore at affected boundaries. Run Playwright after implementation
   for creation, keyboard use, mixed-panel interaction, layout, and export.
4. Measure new expensive paths using representative small/large, paged,
   gap-heavy, and many-panel workloads. Record hardware, inputs, latency, and
   peak resource costs. Rendering reuse alone does not establish performance.
5. Run `./scripts/ci.sh all` for cross-layer implementation, treefmt via
   `./scripts/format.sh`, and `./scripts/version.sh check`. A PR to main has
   exactly one synchronized release bump: minor for compatible features,
   major for breaking API/schema changes, patch for docs/fixes/refactors.
6. Update current behavior in the nearest documentation and close the relevant
   roadmap item with actual evidence. Remove completed proposal detail here
   once current docs/ADRs cover it; keep this file focused on remaining scope.
