# Plot UI refinement review

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

The frontend gate passed all 2,863 tests, lint, generated-schema checks, build,
and snapshot artifact checks. Browser coverage included linked axes, explicit
signal-X and color bindings, cursor modes, workspace layouts, signal selection,
and snapshot round trips.

The final two-test legend rerun still failed and needs follow-up before merge:

- The enlarged-font workspace expected a 15px legend but observed 12px. An
  earlier run passed; the cause of the inconsistent font setting is unresolved.
- Dragging the cursor-tip divider in a short legend did not increase the tip
  section's height. Its new flex sizing needs further adjustment.

The captures record the reviewed workspace; they do not establish that these
remaining interaction checks pass. Validation used the browser application,
not a packaged Electron build.
