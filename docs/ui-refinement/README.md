# Plot UI refinement review

The latest toolbar uses compact plot, style, and readouts menus with current
values in the buttons. Width, dimming, legend modes, statistics, and tips are
direct choices within each menu. [Compact header](compact-panel-menus.png) and
[open style menu](compact-style-menu.png) show the latest narrow-panel layout.
The earlier dense-workspace captures below document the inline toolbar revision.

The simple legend contains line
samples and names; search, bulk actions, encoding controls, and detailed readouts
remain in expanded and docked legends. The mode picker reads collapsed,
simple, expanded, and docked. [Simple legend capture](after-simple.png).

These captures show the same 48-signal workspace (86,400 samples) in the running
application, using visible Chromium at device scale 1. The left legend floats;
the right legend is docked. Signals 1 and 2 are focused, signals 2 and 3 are
hidden, and the other visible signals are dimmed to 35% by the existing rule.

| Workspace                      | Before                                                 | After                                                 |
| ------------------------------ | ------------------------------------------------------ | ----------------------------------------------------- |
| 1440 × 900; UI 13px, plot 9px  | [Native scale](before-native.png)                      | [Native scale](after-native.png)                      |
| 1100 × 900; UI 18px, plot 13px | [Larger fonts, narrow panels](before-large-narrow.png) | [Larger fonts, narrow panels](after-large-narrow.png) |

![Before, native scale](before-native.png)

![After, native scale](after-native.png)

Controls remain inline and wrap by purpose. `c:` now reads `color:`, `axis`
reads `limits`, and the width sample has a text label. Existing popovers and
actions retain their behavior. Long paths preserve their distinguishing suffixes
and expose their full names in tooltips. The
[control inventory and typography details](../../frontend/src/styles/README.md#plot-readability)
document the changes.

After review, legend signal text follows the plot font size, capped at the small
UI caption size: 9px by default and at most 11px at the default UI size, even
when plot text is enlarged. Increasing the UI size still allows larger legends.
Expanded floating and docked legends use compact bordered buttons in the UI font for
Select all, Dim all, and Hide all directly above the encoding controls. These
become Clear selection, Undim all, and Show all when applicable. They affect all
assigned signals, including filtered rows. Hide and Dim preserve selection;
Undim all restores full opacity and disables the dim-other-traces rule. The
toolbar labels that separate rule `dim others`. Each bulk action is one undo
step and uses the existing serialized focus and override fields.

Hidden and dimmed states have separate indicators; focus remains additive and
does not alter visibility. Narrow legends use hollow/half-circle symbols with
tooltips. The existing dim-non-focused rule still responds to focus. Compact
keys remain available, while font changes now resize legend text and keep the
signal browser's virtual rows aligned. Statistics headers follow horizontal
scrolling and share column widths with values.

`frontend/tests/e2e/ui-refinement.spec.ts` creates the captured workspace and
checks focus, hidden and dimmed states, keyboard selection and restore,
enlarged typography, toolbar access, virtual scrolling, and statistics alignment.
Run it with `./scripts/test.sh e2e ui-refinement.spec.ts --workers=1 --headed`.
Captures are written to `build/ui-review/` and attached to the test results.
To repeat the baseline capture, serve the base revision on port 4174 and set
`SIGNALSCOPE_UI_CAPTURE=before` for the same test command.

## Validation status

The compact-menu follow-up passed one focused browser check for menu access,
direct style choices, picker focus restoration, and single-row headers with
side-by-side panels at 1100px. The CI follow-up removes interpolated toolbar
markup and makes tests select expanded legends before exercising editing
controls. The frontend gate passed all 2,867 unit tests, lint, type checking,
schema checks, and snapshot validation; the quality gate also passed. Full
browser validation is delegated to GitHub CI. Earlier dense-legend checks
belong to the previous revision. Browser validation uses Chromium, not
packaged Electron.
