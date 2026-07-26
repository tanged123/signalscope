# 16. The sequential colormap is theme-invariant batlow

Status: Accepted

## Context

The Final Spec requires a labelled colorbar whenever a `c:` colour channel is
assigned, and states only that the colormap is "perceptually uniform +
colorblind-safe (viridis-class)". It supplies no stops. Its own F2 mock fills
the colorbar with a gradient built from three _categorical_ series tokens,
which the same handoff forbids ("separate from the categorical series
palette") and which is non-monotonic in lightness in the light theme.

ADR 0011 already fixed the source: Crameri's Scientific colour maps, `batlow`
for sequential magnitude, no rainbow map, no map lacking monotone lightness.
It deliberately shipped no tokens, because nothing read them yet.

## Decision

`--seq-01` … `--seq-16` are sixteen evenly spaced samples of `batlow` (rows
1, 18, 35, … 256 of the published 256-entry table), declared once in `:root`.

Unlike the categorical slots, the ramp is **theme-invariant**. A categorical
slot's job is identity, so ADR 0011 re-steps its lightness per surface. A
sequential ramp's job _is_ its monotone lightness: re-stepping it per surface
would collapse the property that makes it admissible, and the colorbar's 1px
border already separates its dark end from a near-black surface.

Acceptance is by computed check in `frontend/src/styles/palette.test.ts`:
strictly increasing OKLab lightness unsimulated and under Machado protan and
deutan simulation, and a lightness span wide enough to survive greyscale.

## Consequences

- The `c:` colorbar and the colour-mapped trajectory read identically in both
  themes, so a caption naming a colour stays true across the theme toggle —
  the same requirement that drove ADR 0011.
- Sixteen stops with linear interpolation between them is visually
  indistinguishable from the full 256-entry table at any colorbar size this
  app draws, and keeps the token sheet readable.
- A diverging ramp (`vik`/`roma` per ADR 0011) is still unshipped. Add it the
  same way, with its own computed checks, when something reads it.
