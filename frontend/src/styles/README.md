# Workbench appearance

The appearance exploration applies the Pantheon study's typography hierarchy,
control corners, and surface separation to SignalScope's existing workbench.
The production UI remains the reference for controls, layout, and interaction.
The study's product masthead, separated plot cards, fixed readout strips, rust
actions, and mobile layouts are not part of this pass.

## Shared visual rules

- Panels remain contiguous with square shared seams. Independent controls and
  floating surfaces use 4px corners; connected controls round only their outer
  edge. Panel geometry and virtual row heights are unchanged.
- Inter remains the default UI font. Titles use weight and contrast for
  hierarchy; secondary labels stay readable. Legend headings, encoding controls,
  and footers follow UI font preferences, while series rows and numeric readouts
  retain their existing plot font. UI caption sizes scale with the UI preference.
- Panel headers and legend section headers use the first raised surface. Binding
  chips have their own quiet boundary; toolbar dividers separate groups without
  full-height boxes. Floating legends have opaque backgrounds for readable data.
- Hover and selection use neutral surfaces. Amber keeps its interaction meaning,
  including search focus. Essential keyboard controls have a visible focus edge.
  Reduced motion disables the existing short control transitions.
- Dark and Light have revised surface and text steps. Graphite and Paper retain
  neutral palettes with clearer secondary text. Both high-contrast themes retain
  strong seams and omit decorative shadows. Theme previews use the same tokens.
  Scientific palettes and explicit overrides remain independent of chrome.

## Stylesheet ownership

`app.css` composes styles in cascade order and retains shell breakpoints.
`base.css` owns shared elements, title, tabs, and application menu;
`signal-dock.css` owns search and source actions; `signal-outline.css` owns the
virtual tree and import progress. `panel-toolbar.css` owns panel chrome and
configuration controls. `legend-layout.css`, `legend-roster.css`, and
`legend-details.css` own legend geometry, series/statistics, and tips/inspectors.
`workspace-layout.css` owns axes overlays, formula/status bars, and workspace
seams. `dialogs.css` owns import, command, and export surfaces. `chrome.css`
retains desktop titlebar integration and informational dialogs.

`tokens.css` owns shared typography, radii, and Dark/Light values; `themes.css`
owns named variants. There is no new theme registry, state, schema, or renderer
boundary. The existing preference publication and offline bundle carry these
styles to live and baked workspaces.

## Verification

Theme tests cover preview/root agreement, secondary text contrast, and selected
and hover text contrast across all six themes. Browser tests exercise search
focus, inline controls, unchanged geometry between themes, UI font preferences,
and enlarged text at narrower desktop widths. The theme matrix attaches review
screenshots to the GitHub CI `playwright-results` artifact on successful runs as
well as failures. Existing browser and snapshot tests cover legend interactions,
palette independence, and offline appearance round trips.
