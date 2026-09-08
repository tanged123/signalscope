# ADR 0061: Configurable scientific palettes

- Status: Accepted
- Date: 2026-09-08
- Amends: [ADR 0011](0011-series-palette-and-reserved-amber.md), [ADR 0023](0023-global-preferences-file.md),
  [ADR 0057](0057-continuous-line-color-axis.md), and
  [ADR 0059](0059-snapshot-appearance-and-bundle-colors.md).

## Context

Users need discrete scientific color sets and continuous maps, with custom
colors, selectable beside fonts in Settings. Previously categorical colors
were CSS constants and the C axis sampled a separate hardcoded Viridis map.
The user's requested controls extend the Final Spec's appearance settings;
data previews may show gradients while chrome remains achromatic and flat.

## Decision

Global preferences own the selected discrete and contour presets, one saved
custom set for each, and continuous reversal. Settings exposes two entries,
each opening a native modal with preview, preset selector, custom color pickers
and hex fields, and Apply/Cancel. Custom discrete colors can be reordered.
Continuous stops have editable percentage positions. Edits remain in a local
draft until one validated publication; close or Escape discards the draft and
restores focus. Dialog-owned listeners disappear with its DOM.

`app/palettes.ts` owns preset metadata, custom validation, ordered colors,
and piecewise linear sRGB sampling over normalized positions. It depends only
on generated preference types, bundled data and the shared binary search.
It has no DOM, transport, Line2D or GPU dependency; future accepted plot
families can consume the same colors and sampler without another palette API.
No future plot family, normalization mode, or renderer is introduced here.
`app/color-scale.ts` retains numeric domain ownership.

Discrete sets contain any nonempty list of arbitrary #RRGGBB colors.
Automatic hues retain their
ordinal; rendering wraps once using the active palette length. Existing
overrides remain slot identities across palette changes. Labels, dashes,
focus and picking continue to identify traces when colors repeat.
Custom continuous sets contain at least two finite strictly increasing stops, with
endpoints exactly 0 and 1. Reversal transforms stop positions and order without
altering saved custom data. Presets retain all 256 upstream samples.

Preferences apply CSS series tokens, active color count, and serialized
contour stops. The existing theme invalidation compiles and caches one render
palette. Contour identity survives unrelated font or theme changes.
Line2D receives that explicit contour identity and color count;
color attribute caches compare both domain and contour identity. A palette
edit replaces RGBA feeds while reusing coordinate feeds; viewport-only changes
retain them. ChartHost, colorbars, PNG capture and HTML exports share the same
selected palette. There is no network lookup or new runtime dependency.

Preference schema 7 adds defaults and accepts versions 1–6. Version 6 keeps
its stroke scale; older stroke migration remains intact. Invalid custom sets
repair independently to MATLAB colors or black/white stops; unknown presets
repair to MATLAB or Viridis, and future versions still fail without rewrite.
Rust and TypeScript repair the same fields. Session schema 32 widens color
slots from u8 to u32; the v31 migration preserves existing slot values and
advances the version. Earlier supported sessions still migrate through the
existing ladder, and older applications reject the newer version clearly.
The JSON shape and data protocol remain unchanged. The snapshot appearance whitelist includes all five palette fields,
so offline snapshots retain custom colors and reversal. About includes bundled
source and license notices, including in exported HTML.

`ui/panel-render.ts` owns preparation of a panel's palette, strokes, emphasis
indices and render request. It accepts only appearance/series state, a line
response, a window and emphasized paths. It captures one resolved palette for
both family preparation and the final request; the panel retains range
selection and ChartHost publication. No resource or asynchronous lifetime
moves across this boundary. Existing panel behavior tests validate rendering;
the extraction does not exempt the remaining oversized panel from ADR 0053.

Snapshot artifact checks exempt only the complete bundled license notice
literal from HTTP detection. Standalone URLs, including multiline fetch
arguments, remain rejected; the snapshot policy regression tests cover both.

## Alternatives and tradeoffs

Keeping all colors in CSS cannot express arbitrary positioned stops or
provide a renderer-independent sampler. A palette package would add a runtime
dependency for a small static dataset. A large palette browser and multiple
named custom collections add persistence and UI complexity without a current
need. One retained custom palette of each kind keeps editing small.

The initial eight-color and 32-stop editor caps were removed at the user's
request. Neither is a rendering limit. Palette size follows the actual list,
including for CSS tokens, inspector choices, and renderer indexing.
Presets include MATLAB, Tol, Okabe–Ito, Tableau and ColorBrewer discrete sets,
plus the Matplotlib and Scientific colour maps continuous tables. Color
pickers wrap or scroll rather than imposing a palette-size limit.
Custom colors make no claim of perceptual uniformity or color-vision safety.
Sequential and diverging preset labels describe intended uses; a diverging
map's middle is the numeric range midpoint, not an automatic zero-centered
normalization. MATLAB and Viridis remain the defaults.

## Validation

Behavior tests cover migration, malformed colors and positions, custom
roundtrip and snapshot capture, exact stop interpolation, reversal, palette
cache invalidation without coordinate rebuilding, dynamic categorical
wrapping, editor validation and cancellation. Playwright covers keyboard
settings access, applying custom colors and restoring appearance defaults.
The shared default fixture verifies Rust/TypeScript agreement. Frontend
artifact checks verify offline bundling; hosted CI supplies the full checks.

## Consequences and implementation status

The implementation is delivered with this ADR. Preset provenance and data
conversion are recorded in
[`palette-notices.txt`](../../frontend/src/app/palette-notices.txt).
This feature has one synchronized minor version bump to 2.6.0.
