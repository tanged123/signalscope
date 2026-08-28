# Axis tick labels collapse after zoom

## Symptom

After zooming into a narrow time or value range, distinct ticks render as the
same whole number. For example, nearby X ticks all display as `323` and nearby
Y ticks all display as `1`. The plotted data remains distinct; only the labels
are wrong.

## Reproduction

1. Load a time-series corpus and open a time panel.
2. Zoom into a narrow X or Y interval around a nonzero value.
3. Observe that multiple tick marks have identical integer labels even though
   they represent different floating-point values.

## Root cause

`formatTicks()` derives fractional precision from the smallest gap in an array
of tick values. `ChartHost` installs ChartGPU callbacks that call it with a
single value:

```ts
formatTicks([value + this.tRef]); // X
formatTicks([value]); // Y
```

A singleton has no measurable gap, so `formatTicks()` selects zero fractional
digits. ChartGPU invokes `tickFormatter` once per tick, making this the normal
path for every finite value outside the exponential-format thresholds.

Affected code:

- `frontend/src/render/plot-theme.ts` — `formatTicks()`
- `frontend/src/render/chart-host.ts` — X/Y `tickFormatter` callbacks

## Required behavior

- Derive precision from the visible axis span or tick step, not from a
  singleton callback value.
- Display enough fractional digits that adjacent finite tick labels remain
  distinct at the current zoom level.
- Prefer a readable fixed-point representation with one guard digit when
  practical, up to eight fractional digits; use scientific notation when
  fixed-point labels would still collide or become misleading.
- Preserve the Unicode minus sign and existing large/small-number behavior.
- Preserve absolute X labels after SignalScope adds `tRef` back to ChartGPU's
  rebased X values.
- Apply the same precision policy to X and Y axes.

Do not solve this with a fixed decimal count: precision must increase as the
visible range narrows.

## Suggested implementation

Create a range-aware formatter when building each axis. Pass it the visible
span or an estimated nice-tick step, then format each callback value with that
stable precision. Keep time rebasing separate: derive X precision from the
rebased span, but format `value + tRef`.

Changing the tile protocol, renderer resolution, or ChartGPU data buffers is
out of scope.

## Acceptance criteria

- A narrow X range around `323` produces distinct decimal labels.
- A narrow Y range around `1` produces distinct decimal labels.
- Zooming further increases displayed precision when necessary.
- Zooming out removes unnecessary fractional digits.
- Negative, very small, and very large tick values remain readable.
- Unit tests cover singleton callback formatting and both rebased X and plain
  Y ranges.
- A Playwright regression zooms a panel and asserts that visible tick labels
  are not duplicate whole numbers.

## Validation

```bash
./scripts/test.sh unit plot-theme chart-host
CI=1 ./scripts/test.sh e2e
./scripts/format.sh
```
