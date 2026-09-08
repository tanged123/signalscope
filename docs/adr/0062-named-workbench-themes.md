# ADR 0062: Named workbench themes

- Status: Accepted
- Date: 2026-09-08
- Amends: [ADR 0011](0011-series-palette-and-reserved-amber.md),
  [ADR 0023](0023-global-preferences-file.md), and
  [ADR 0061](0061-configurable-scientific-palettes.md).

## Context

The user requested formal theme selection beyond the original Dark/Light
toggle. Themes should change workbench chrome and plot backgrounds while
leaving discrete and contour palettes independent. The initial additional
themes are Graphite, Paper, High Contrast Dark, and High Contrast Light,
preserving flat achromatic chrome and amber interaction accents.

## Decision

`app/themes.ts` owns the typed theme catalog, display names, light/dark
classification, validation, and deterministic cycling order. It depends only
on generated preference types. CSS owns semantic token values: `tokens.css`
retains the original Dark/Light defaults, while `themes.css` supplies named
variants. Both the root and preview cards use the same selectors and tokens.
The registry does not replace the existing palette sampler or renderer theme
cache. Renderers continue to consume resolved tokens, not named theme IDs.

Settings → Theme opens preview cards. Selecting a card publishes the selected
ID through the existing theme mutation path and closes the picker. Dismissal
does not change state. `ui/theme-picker.ts` owns the choices and presentation;
`ui/info-dialog.ts` owns modal focus, keyboard trapping, dismissal and cleanup.
The T shortcut now advances through the catalog and wraps to the default.
Its command is labeled “Cycle theme.” The first step remains Dark → Light.

Global preferences remain authoritative for the running app. A theme change
updates the session's copy, schedules session and preference saves, applies
the root's theme and color-scheme attributes, and invalidates presentation.
Offline restore uses the session copy, so an exported HTML file opens with
the chosen named theme. All theme data is bundled and switching needs no
network access. The Electron preload already publishes resolved titlebar
tokens and needs no theme-specific behavior.

The theme enums in the PR's unreleased preference schema 7 and session schema
32 include all catalog IDs. Existing Dark/Light values retain their meaning
through the existing migrations. Unknown preference names repair to Dark;
unknown session names or unsupported versions reject without partial restore.
The PR retains its single 2.6.0 minor version bump.

## Alternatives and tradeoffs

Adding more branches to the binary toggle would leave Settings without direct
selection and duplicate cycling logic. A general theme engine or arbitrary
token editor would introduce additional validation and persistence without
a current requirement. A small typed catalog over semantic CSS tokens is
sufficient. A new theme adds catalog metadata, enum variants and CSS tokens;
it does not alter plot code.

Themes do not silently substitute user-selected series or contour colors.
The high-contrast variants strengthen chrome text and seams; they do not
claim that arbitrary custom plot colors are accessible on every background.

## Validation and implementation status

The implementation accompanies this ADR. Tests cover cycling through every
theme, preference and session roundtrips in both languages, unchanged plot
palettes, preview/root token agreement, and readable text contrast.
Browser coverage exercises direct Settings selection, T cycling and named
themes in offline snapshots. The previously positional font-size browser
test now selects its setting by name, allowing Settings to grow.
