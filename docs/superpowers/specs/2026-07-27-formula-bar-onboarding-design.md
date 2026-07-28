# Formula bar onboarding and completion

## Problem

The derived formula bar exposes a compact expert surface without teaching its
language. A new user can type a visible leaf name such as `pitch_deg` and get
`unknown name`, or copy the placeholder's fictional `imu/vx` path and get
`unknown signal`. Neither error explains that signal references require the
quoted full path.

The bar needs to teach the language without permanently consuming plot space.
It must also let users compose formulas from several real signals without
typing or memorizing their paths.

## Decisions

Delivery has two stages:

1. Compact help, first-use onboarding, and drag insertion.
2. Context-sensitive completion for functions, constants, and loaded signals.

The bar remains one row high. It does not become a wizard, node editor, or
multi-row persistent teaching surface.

## Stage 1: help and drag insertion

The expanded bar contains its existing `ƒx` mark and input plus:

- a visible `?` button;
- the existing inline error region;
- an amber drop-target state while a tree signal is over the bar.

The help popover opens automatically the first time the formula bar is opened.
Closing it records a local preference. Later opens stay compact, and `?` always
reopens the popover. Storage failure degrades to showing first-use help again
after restart.

The popover contains:

- `derived/name = expression`;
- the rule that a signal is its quoted full path;
- a real example using a currently loaded signal, when one exists;
- `gradient`, `cumtrapz`, `movmean`, `abs`, and a two-input `hypot` example;
- Enter, arrow-history, Escape, drag insertion, and later `Ctrl+Space`
  controls.

No example names a signal that is not loaded. With no signals, the popover says
to load a source and drag signals from the tree.

Dragging a signal from the tree onto the input inserts only its quoted full
path at the current selection or caret. It replaces selected text and leaves
the caret after the inserted reference. If the input has no selection state,
the reference is appended. Repeated drops therefore support formulas such as:

```text
derived/speed = hypot('demo_flight/velocity_body/x', 'demo_flight/velocity_body/y')
```

The input retains focus after a drop. The help popover does not open on every
drop.

Errors preserve the complete input and remain announced through the existing
alert region. While an error is visible, the bar also says:
“Signal references use quoted full paths. Drag from the tree to insert.”
This guidance is stable and does not depend on parsing backend error strings.

## Stage 2: context-sensitive completion

Completion is anchored to the formula input and uses the text and caret
position to choose one source:

- an identifier prefix suggests functions, constants, and `t`;
- text inside a single- or double-quoted reference searches loaded signal
  paths;
- `Ctrl+Space` opens the appropriate list manually, including an empty-prefix
  list.

Completion is active only on the expression side of an assignment, or
throughout a bare expression. It never offers functions while the user edits a
derived path on the assignment's left side.

Function entries include their signature and short meaning. Accepting a
function inserts its call shape and places the caret at the first argument.
Accepting a signal replaces only the active quoted-reference range with the
correctly quoted path.

When completion is open:

- Up and Down move through suggestions;
- Enter or Tab accepts the selected suggestion;
- Escape closes completion without collapsing the formula bar.

When completion is closed, Up and Down retain formula-history behavior, Enter
creates the derived signal, and Escape collapses the bar.

Filtering is case-insensitive and ranks prefix matches before substring
matches. Signal labels show the full path so similarly named leaves remain
distinguishable. The initial implementation does not add fuzzy scoring,
documentation search, or expression validation requests.

## Components and data flow

Formula behavior moves from `AppShell` into a focused `FormulaBar` UI
component. It owns:

- input and selection state;
- accepted-formula history;
- first-use help state;
- drag/drop presentation and insertion;
- error presentation;
- completion state and keyboard routing.

`AppShell` supplies:

- the current loaded signal paths;
- whether deriving is available;
- an async creation callback.

After ingest or signal reload, `AppShell` updates the component's signal-path
index. Creation still uses the existing derived port and
`AppShell.createDerived`; the protocol and evaluator remain the single
semantic path.

Pure helpers remain outside the DOM component:

- quote and insert a signal path at a selection;
- detect completion context and replacement range;
- build and rank completion entries;
- apply a selected completion.

The component adds no runtime dependency and uses the existing signal drag
MIME type.

## Quoted-path correctness

The lexer currently terminates a reference at the first matching quote and has
no escape form. Dragging an untrusted path containing both quote characters
could therefore generate an expression that cannot name the signal.

Signal references gain MATLAB-style doubled-delimiter escaping:

- `'pilot''s/"pitch"'` decodes to `pilot's/"pitch"`;
- `"pilot's/""pitch"""` decodes to the same path.

Insertion prefers single quotes and doubles embedded single quotes. The lexer
decodes doubled delimiters before store lookup. Existing quoted references are
unchanged.

## Accessibility and visual rules

The help and completion surfaces use flat existing popover tokens: no gradient,
glow, or decorative shadow. Amber appears only on the drag target, focus, and
derived mark.

The help button has an accessible name and expanded state. The help popover is
keyboard dismissible. Completion uses combobox/listbox semantics, exposes the
active option, and does not trap focus. Pointer selection and keyboard
selection perform the same insertion.

## Testing

Rust tests cover doubled delimiters in both quote styles, decoded references,
unterminated references, and existing syntax.

TypeScript unit tests cover:

- insertion at start, middle, end, and over a selection;
- repeated drops;
- quote doubling;
- identifier and quoted-signal completion contexts;
- ranking and replacement ranges;
- function call and signal completion application;
- history keys when completion is closed.

Playwright mounts the formula component with a stub creation callback because
the baked snapshot plane cannot derive. It covers:

- automatic first-use help and remembered dismissal;
- help-button keyboard and pointer paths;
- a real loaded-path example;
- drag insertion at the caret and drop-target styling;
- actionable error guidance;
- function and signal completion;
- Escape, Enter, Tab, Up, and Down routing;
- the snapshot bar remaining hidden when the plane cannot derive.

The full repository gate must remain green after each stage.

## Acceptance

A user unfamiliar with the grammar can open the bar, learn the formula shape,
and construct a valid multi-signal expression by dragging real tree leaves.
They never need to infer a path from the tree's indentation. A keyboard user
can discover and complete the same functions and signals without a pointer.

Session save/load and autosave remain outside this work and resume only after
both onboarding stages are accepted.
