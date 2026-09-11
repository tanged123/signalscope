# Workbench appearance

The appearance exploration applies the Pantheon study's typography hierarchy,
control corners, and surface separation to SignalScope's existing workbench.
The production UI remains the reference for controls, layout, and interaction.
The study's product masthead, separated plot cards, fixed readout strips, rust
actions, and mobile layouts are not part of this pass.

## Shared visual rules

- Panels remain contiguous with square shared seams. Independent controls and
  floating surfaces use 4px corners; connected controls round only their outer
  edge. Panel layout and docking remain unchanged.
- Inter remains the default UI font. Titles use weight and contrast for
  hierarchy; secondary labels stay readable. Legend headings, encoding controls,
  and footers follow UI font preferences, while series rows and numeric readouts
  retain their existing plot font. UI caption sizes scale with the UI preference.
- Panel headers and legend section headers use the first raised surface. Binding
  chips have their own quiet boundary; toolbar dividers separate groups without
  full-height boxes. Floating legends stay opaque during pan and zoom for readable
  data. Workspace tabs align with the panel and maximized-panel bar seams.
- Hover and selection use neutral surfaces. Amber keeps its interaction meaning,
  including search focus. Essential keyboard controls have a visible focus edge;
  focusing a whole panel does not add a surrounding highlight.
  Reduced motion disables the existing short control transitions.
- Dark and Light have revised surface and text steps. Graphite and Paper retain
  neutral palettes with clearer secondary text. Both high-contrast themes retain
  strong seams and omit decorative shadows. Theme previews use the same tokens.
  Scientific palettes and explicit overrides remain independent of chrome.

## Plot readability

At the default 13px UI setting, supporting controls use 11px and signal names
use 12px. Panel titles retain their stronger weight. Legend series use the plot
font at the selected plot size, capped at the UI caption size: 9px by default,
and at most 11px with the default UI size. UI and plot font preferences remain
independent; increasing both can still enlarge the legend. Axis sizes are unchanged.

The signal browser uses 26px rows at the default UI size and scales its virtual
row geometry with font changes. Smaller UI sizes retain 22px compact rows.
Legend roster/rail rows start at 26px and grow with plot text; the existing
compact keys mode retains a 24px minimum. Numeric columns use tabular numerals
and grow with plot text. Long names truncate with full-path tooltips; encoding
summaries and inspector controls wrap within narrow legends.
Statistics use shared column widths and scroll their headers with the values.

Expanded legends use compact bordered buttons in the UI font for
Select all / Clear selection, Dim all / Undim all, and
Hide all / Show all in a visible row above the encoding controls. These act on
every assigned signal, including rows outside the current filter. Hiding and
dimming preserve focus; selecting preserves visibility and explicit opacity.
Undim all also disables the dim-non-focused rule. Each action is one undo step.
The workspace publishes these changes once; `app/panel-series-actions.ts` owns
the transitions using existing focus and override fields. `ui/legend-bulk-actions.ts`
owns the buttons, and their keyboard focus survives refreshes. Session/snapshot
schemas and the renderer resolution rules are unchanged.

The panel header exposes Data & axes, Appearance, and Analysis dropdowns with
visible configuration summaries. Truncated summaries retain their full text in
tooltips; group buttons wrap at narrow widths. Data & axes contains assignments,
axis presentation, and limits; Appearance contains width, dimming, and legend
presentation; Analysis contains statistics and tips. Title, binding summaries,
and panel lifecycle actions stay outside. Setting pickers replace the group
dropdown and return focus to its button. Tab, arrow keys, and Escape provide
keyboard paths. Existing shortcuts and legend bulk actions remain available.
[ADR 0065](../../../docs/adr/0065-panel-toolbar-groups.md) records the shared
toolbar contract and Line2D control ownership. The control inventory is:

| Control                           | Behavior                                                                |
| --------------------------------- | ----------------------------------------------------------------------- |
| Drag handle and title             | Rearrange panel; double-click title to rename                           |
| Binding summaries                 | Inspect assigned signals/bundles and remove bindings                    |
| Axes presentation                 | Switch gutter/inline axes                                               |
| Y add                             | Assign signals or bundles                                               |
| X summary                         | Choose linked time, signal, or bundle                                   |
| Color summary                     | Choose/clear color axis (previously abbreviated `c:`)                   |
| Limits                            | Existing ranges, scales, direction, and equal units (previously `axis`) |
| Width                             | Panel line-width default; now labeled beside the line sample            |
| Dim others                        | Existing opacity choice for non-focused traces                          |
| Legend                            | Badge, compact keys, roster, or docked rail                             |
| Statistics                        | Toggle visible-region columns                                           |
| Tips                              | Existing labels/markers/visibility and pin actions                      |
| Right/down split, maximize, close | Existing panel lifecycle actions                                        |

Focus remains the existing additive selection model, including range and
Command/Ctrl toggles. Hidden traces show `hidden` with a hollow swatch; visible
traces with reduced opacity show `dimmed`. Below 220px legend width, these labels
use distinct hollow-circle and half-circle symbols with descriptive tooltips.
Names retain readable contrast and never use strikethrough for dimming.
Focus highlights compose with hidden state
in keys, rosters, and statistics. Mute/restore and Option-click retain their
existing behavior. The deliberately configured dim-non-focused rule still
responds to focus; selecting a row does not change visibility or that rule.
Workspace tabs, linked time, cursor mode, and draggable/dockable legends retain
their existing controls and behavior.

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
The packaged Electron smoke test waits for application readiness and checks
that the native window background follows the active `--surface-1` token after
keyboard theme changes.

The [before/after review](../../../docs/ui-refinement/README.md) records the
dense workspace, font sizes, and capture command for this refinement.
