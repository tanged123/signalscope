# 11. Series palette, reserved amber hue band, and colormap sources

Status: Accepted

## Context

The Final Spec shipped eight categorical series slots per theme and recorded
"Colorblind validation pending — fallback: prototype palette". Validation found
the dark palette placed all eight slots at OKLCh L 0.718–0.918, outside the
0.48–0.67 band for a near-black surface, so the slots differed almost only in
hue — the channel that colour-vision deficiency, print, and glare destroy first.
Dark `--series-1` was also byte-identical to `--amber-9` (#FFB648), which the
same spec reserves for interaction roles only: cursor, focus inset, delta
readouts, derived/fx marks, pinned emphasis, and drop targets.

The spec additionally stated that slot colours differ per theme by design. In
practice both palettes ship inside every HTML snapshot and the recipient can
toggle themes offline, so a caption naming a colour becomes wrong on toggle.
"Captions are not optional" (Rougier, Droettboom & Bourne, rule 4) only holds if
a caption stays true.

## Decision

1. Both themes share one hue order. A slot keeps its hue across the theme
   toggle; only lightness and chroma are re-stepped per surface.
2. OKLCh hue 55 degrees to 90 degrees is a reserved amber band. No series slot
   may occupy it, and no slot may sit within OKLab delta-E 10 of `--amber-7` or
   `--amber-9`. Amber remains interaction-only.
3. Palette values are derived, not picked. The derivation is:
   - Start from the reference data-viz categorical palette, which is what the
     light theme already shipped: #2a78d6 / #eb6834 / #1baf7a / #eda100 /
     #e87ba4 / #008300 / #4a3aa7 / #e34948.
   - Keep seven of its hue families unchanged: blue 255 degrees, orange 41,
     green 162, violet 284, pink 357, deep green 142, red 25.
   - Evict its amber slot (#eda100, hue 75.1 degrees), which falls inside the
     reserved band, and substitute an azure at 205 degrees — the widest
     remaining gap in the hue circle.
   - Re-order, then re-step each slot in OKLCh against the mode's lightness
     band. Anyone adding, removing, or re-stepping a slot repeats this
     procedure.
4. Acceptance is by computed check, never by eye: lightness band, chroma floor,
   adjacent OKLab delta-E under Machado-Oliveira-Fernandes protan and deutan
   simulation, an unsimulated normal-vision floor, and WCAG contrast against
   the surface. Those checks run as a frontend unit test over `tokens.css`,
   calibrated against known-answer fixtures so the checker itself cannot rot.

### The light-theme contrast trade

Light slots 3, 6, and 8 measure 1.88, 1.94, and 2.13 against `--surface-0`,
below the 3:1 mark floor. This is accepted and it is deliberate.

The light palette's lightness is bimodal — slots 2/5/7 near L 0.44, slots 3/6/8
near L 0.76 — and that alternation is the mechanism that produces its CVD
margin: worst adjacent delta-E 21.8 against a floor of 8, and 24.2 unsimulated
against a floor of 15. Re-stepping slots 3, 6, and 8 upward to clear 3:1 was
tried and rejected: it collapses slots 7 and 8 to delta-E 2.6 under protanopia,
merging red with deep green. Surface contrast was spent to buy separation.

The warning is discharged by the relief channel the method requires: legend
chips carry the signal path as text beside every swatch, so identity is never
colour-alone. A test asserts that chips render their text, so the relief cannot
be removed silently.

### Headroom

Both palettes sit close to their gates. Dark slot 6 has chroma 0.104 against a
0.10 floor, dark slot 7 sits at L 0.490 against 0.48, dark slot 4 contrasts at
3.14:1 against 3:1, and the dark adjacent CVD margin is 10.1 against 8. A future
edit that fails the test is to be answered by re-deriving the palette, never by
relaxing a threshold in the test.

## Sequential and diverging colormaps

No `--seq-*` or `--div-*` tokens are defined in phase 1 — nothing reads them
yet, and shipping unread tokens is the mistake this plan exists to stop
repeating. The source is fixed now so phase 2 cannot invent one:

Sequential and diverging colormaps are sampled from Fabio Crameri's Scientific
colour maps (Zenodo, DOI 10.5281/zenodo.1243862; MIT licensed) — `batlow` for
sequential magnitude, `vik` or `roma` for diverging polarity about a neutral
midpoint, `oleron`/`bukavu` for topographic surfaces should 3D panels land.
They are perceptually uniform, colour-vision-deficiency safe, and readable in
greyscale, which is what the Final Spec already demands of the `c:` colorbar.
No rainbow map (`jet`, `turbo`) and no map lacking monotone lightness is
admissible.

`batlowS` is explicitly not the source for the categorical slots above. It is
an ordered categorical sampling of a monotone-lightness ramp, so its entries
span lightness from near-black to near-white by design — exactly what the
categorical lightness-band check rejects, and exactly what disappears against a
fixed near-black surface. It is the right tool for ordinal encodings (Monte
Carlo run index, tiers, buckets) and the wrong one for series identity.

## Consequences

- The eight slot values change in both themes. `color_slot` is serialized, so
  sessions and snapshots written before this change re-render in new colours.
  No migration is added: the field's meaning is unchanged and phase 1 has no
  released artifacts to preserve.
- Adding a ninth categorical hue is now explicitly out of bounds. Series beyond
  slot 8 are distinguished by dash class.
- This record supersedes the Final Spec's per-theme slot assignment and its
  pending-validation note. The spec is not rewritten.
