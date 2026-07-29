# ADR 0025: Orthogonal export range and fidelity

- Status: Accepted
- Date: 2026-07-29
- Supersedes: The level-selection paragraph of ADR 0024

## Decision

HTML export selects range and fidelity independently. Range is either the
visible panel window or all loaded signals. Fidelity is preview (512 bins),
standard (2,048), high (16,384), or full (level zero).

The ceilings are upper bounds. Sparse signals remain at level zero, and
signals used by XY, FFT, or histogram panels always remain at level zero
because sample-domain queries cannot reconstruct valid inputs from envelope
bins.

The export estimate reports all eight range/fidelity combinations with the
number of decimated and full-rate series and the coarsest reduction ratio.
CSV uses the same fidelity ladder for its visible-window sample request. PNG is
unchanged.

Reduction awareness exists only in the export dialog. Snapshots and CSV files
carry no fidelity marker. The protocol version is 7; version 6 snapshots are
not migrated.

## Consequences

All-loaded previews and full-fidelity visible snapshots are both possible.
The dialog can disclose size and reduction before writing, while identical
inputs and controls still produce byte-stable snapshots. Full exports remain
unbounded and may be large, so the dialog warns above 100 MB.
