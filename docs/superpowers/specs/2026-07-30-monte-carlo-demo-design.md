# Monte Carlo Demo Design

## Decision

Add eight deterministic CSV runs under `examples/monte_carlo/`. Each run has
1,001 samples at 100 Hz with `time`, `command`, `response`, and `temperature`.
Run 8 omits `temperature` to exercise partial-member grouping.

## Generation

`scripts/generate-monte-carlo-demo.mjs` owns the fixture bytes. It varies gain,
damping, delay, bias, and deterministic noise by run. `--check` fails when the
checked-in files differ from generated output.

## Validation

A core test decodes every file, proposes source sets from their signal schemas,
and verifies one eight-member set with run 8 marked missing `temperature`.
`README.md` documents loading the directory as one batch.
