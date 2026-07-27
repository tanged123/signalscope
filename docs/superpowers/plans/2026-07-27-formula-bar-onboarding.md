# Formula Bar Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make derived formulas learnable by adding first-use help, quoted-path drag insertion, and context-sensitive completion without enlarging the docked bar.

**Architecture:** Extract formula state and DOM behavior from `AppShell` into a focused `FormulaBar` component. Keep parsing, text edits, and completion ranking in pure application modules; reuse the existing signal-tree drag payload and the existing derived creation callback. Extend the Rust lexer only to make dragged untrusted paths representable.

**Tech Stack:** Rust 2024, TypeScript, DOM APIs, Vitest, Playwright, Tauri's existing invoke path, treefmt.

## Global Constraints

- Preserve the one-row, 30-pixel docked formula bar and the Final Spec's flat dark/light token system.
- Amber is limited to focus, the formula/derived mark, and the active drag target.
- Add no frontend runtime dependency.
- Signal paths are untrusted data; set DOM text with `textContent` and quote inserted paths without concatenating them into HTML.
- Keep `BakedPlane.derived` null and the snapshot formula toggle hidden.
- Use `./scripts/*.sh` wrappers for formatting, tests, quality, and builds.
- Run `./scripts/format.sh` before every commit and stage only named files.
- Do not bump the release version here; this remains an intermediate checkpoint on the larger Phase 3 branch, whose Task 19 owns the synchronized minor bump.
- Save/load, autosave, and durable session IO remain out of scope.

---

### Task 1: Escaped signal references

**Files:**

- Modify: `core/scope-core/src/expr.rs`

**Interfaces:**

- Consumes: the existing private `tokenize(src: &str) -> Result<Vec<Spanned>, ExprError>`.
- Produces: quoted signal references where a doubled matching delimiter decodes to one literal delimiter.

- [ ] **Step 1: Confirm the current lexer and test locations**

```bash
rg -n "b'\\\\'' \\| b'\"'|tokenizes_signal_references" core/scope-core/src/expr.rs
```

The line numbers will move; edit the matched lexer arm and its nearby tests.

- [ ] **Step 2: Write the failing lexer and evaluation tests**

Add beside `tokenizes_signal_references_in_both_quote_styles`:

```rust
#[test]
fn doubled_delimiters_escape_quotes_in_signal_references() {
    let tokens = tokenize(r#"'pilot''s/"pitch"' + "pilot's/""pitch""""#)
        .expect("tokenizes");
    assert_eq!(
        tokens
            .iter()
            .map(|entry| entry.token.clone())
            .collect::<Vec<_>>(),
        vec![
            Token::Signal(r#"pilot's/"pitch""#.into()),
            Token::Plus,
            Token::Signal(r#"pilot's/"pitch""#.into()),
        ]
    );
}

#[test]
#[allow(clippy::float_cmp)]
fn evaluates_a_signal_whose_path_contains_both_quote_styles() {
    let store = store_with(&[(
        r#"pilot's/"pitch""#,
        &[0.0, 1.0],
        &[2.0, 3.0],
    )]);
    assert_eq!(
        eval(r#"'pilot''s/"pitch"' * 2"#, &store),
        vec![4.0, 6.0]
    );
}
```

Use the exact intended grammar:

- in a single-quoted reference, `''` decodes to `'`;
- in a double-quoted reference, `""` decodes to `"`;
- the other quote character is ordinary path data.

- [ ] **Step 3: Run the core suite to verify red**

```bash
./scripts/test.sh core
```

Expected: at least `doubled_delimiters_escape_quotes_in_signal_references`
fails because the first doubled delimiter currently ends the token.

- [ ] **Step 4: Decode doubled delimiters while scanning**

Replace the quoted-reference lexer arm with:

```rust
b'\'' | b'"' => {
    let quote = byte;
    index += 1;
    let mut name = String::new();
    while index < bytes.len() {
        if bytes[index] != quote {
            let character = src[index..]
                .chars()
                .next()
                .expect("index stays on a character boundary");
            name.push(character);
            index += character.len_utf8();
            continue;
        }
        if bytes.get(index + 1) == Some(&quote) {
            name.push(char::from(quote));
            index += 2;
            continue;
        }
        break;
    }
    if index >= bytes.len() {
        return Err(ExprError::UnterminatedString { start });
    }
    index += 1;
    if name.is_empty() {
        return Err(ExprError::EmptySignal { start });
    }
    tokens.push(Spanned {
        token: Token::Signal(name),
        start,
        end: index,
    });
}
```

The character-based non-delimiter branch preserves UTF-8 signal paths while
the byte checks remain safe for ASCII quote delimiters.

- [ ] **Step 5: Add the unterminated escaped-reference regression**

Add:

```rust
#[test]
fn doubled_delimiters_do_not_hide_an_unterminated_reference() {
    assert!(matches!(
        tokenize("'pilot''s/path").expect_err("unterminated"),
        ExprError::UnterminatedString { start: 0 }
    ));
}
```

- [ ] **Step 6: Verify, format, and commit**

```bash
./scripts/test.sh core
./scripts/format.sh
git add core/scope-core/src/expr.rs
git diff --cached --check
git commit -m "feat(expr): escape quotes in signal references" -m "Doubled delimiters keep dragged untrusted paths representable while matching MATLAB string spelling."
```

---

### Task 2: Formula text-edit helpers

**Files:**

- Modify: `frontend/src/app/formula.ts`
- Modify: `frontend/src/app/formula.test.ts`

**Interfaces:**

- Consumes: no DOM.
- Produces:
  - `quoteSignalPath(path: string): string`
  - `insertSignalReference(text: string, path: string, start: number, end: number): FormulaEdit`
  - `FormulaEdit { text: string; caret: number }`

- [ ] **Step 1: Write failing quote and insertion tests**

Extend the import and add:

```ts
import {
  insertSignalReference,
  parseFormulaInput,
  quoteSignalPath,
} from "./formula";

describe("signal reference edits", () => {
  it("quotes a full path and doubles embedded apostrophes", () => {
    expect(quoteSignalPath("demo/attitude/pitch_deg")).toBe(
      "'demo/attitude/pitch_deg'",
    );
    expect(quoteSignalPath(`pilot's/"pitch"`)).toBe(`'pilot''s/"pitch"'`);
  });

  it("inserts at the caret and leaves the caret after the reference", () => {
    expect(insertSignalReference("derived/x =  * 2", "a/x", 12, 12)).toEqual({
      text: "derived/x = 'a/x' * 2",
      caret: 17,
    });
  });

  it("replaces a selection", () => {
    expect(
      insertSignalReference("derived/x = replace + 1", "a/y", 12, 19),
    ).toEqual({
      text: "derived/x = 'a/y' + 1",
      caret: 17,
    });
  });

  it("supports repeated signal drops", () => {
    const first = insertSignalReference("derived/x = hypot(, )", "a/x", 18, 18);
    expect(
      insertSignalReference(
        first.text,
        "a/y",
        first.caret + 2,
        first.caret + 2,
      ),
    ).toEqual({
      text: "derived/x = hypot('a/x', 'a/y')",
      caret: 30,
    });
  });
});
```

- [ ] **Step 2: Run the frontend suite to verify red**

```bash
./scripts/test.sh frontend
```

Expected: TypeScript reports that the new exports do not exist.

- [ ] **Step 3: Implement the pure helpers**

Append to `formula.ts`:

```ts
export interface FormulaEdit {
  text: string;
  caret: number;
}

/** Quotes a signal path using the expression dialect's MATLAB-style escape. */
export function quoteSignalPath(path: string): string {
  return `'${path.replaceAll("'", "''")}'`;
}

/** Replaces `[start, end)` with one quoted signal reference. */
export function insertSignalReference(
  text: string,
  path: string,
  start: number,
  end: number,
): FormulaEdit {
  const from = Math.min(Math.max(start, 0), text.length);
  const to = Math.min(Math.max(end, from), text.length);
  const reference = quoteSignalPath(path);
  return {
    text: `${text.slice(0, from)}${reference}${text.slice(to)}`,
    caret: from + reference.length,
  };
}
```

- [ ] **Step 4: Verify, format, and commit**

```bash
./scripts/test.sh frontend
./scripts/format.sh
git add frontend/src/app/formula.ts frontend/src/app/formula.test.ts
git diff --cached --check
git commit -m "feat(formula): insert quoted signal references" -m "The pure edit helper preserves selections and applies the same doubled-quote grammar as Rust."
```

---

### Task 3: Extract the FormulaBar component

**Files:**

- Create: `frontend/src/ui/formula-bar.ts`
- Modify: `frontend/src/ui/app-shell.ts`
- Modify: `frontend/tests/e2e/workbench.spec.ts`

**Interfaces:**

- Consumes:
  - `parseFormulaInput(text, fallbackIndex)`
  - `AppShell.createDerived(path, expr): Promise<void>`
- Produces:

```ts
export interface FormulaBarCallbacks {
  onCreate(path: string, expression: string): Promise<void>;
  onClose(): void;
}

export class FormulaBar {
  constructor(element: HTMLFormElement, callbacks: FormulaBarCallbacks);
  setOpen(open: boolean): void;
  setSignals(paths: readonly string[]): void;
}

export function formulaBarMarkup(): string;
```

- [ ] **Step 1: Add a failing direct-component Playwright test**

At the top of `workbench.spec.ts`, add:

```ts
import type { FormulaBar as FormulaBarClass } from "../../src/ui/formula-bar";
```

Add after the legend probe:

```ts
test("formula component creates and recalls accepted formulas", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const modulePath = "/src/ui/formula-bar.ts";
    const { FormulaBar, formulaBarMarkup } = (await import(
      /* @vite-ignore */ modulePath
    )) as {
      FormulaBar: typeof FormulaBarClass;
      formulaBarMarkup: () => string;
    };
    const host = document.createElement("div");
    host.id = "formula-probe";
    host.innerHTML = formulaBarMarkup();
    document.body.replaceChildren(host);
    const bar = new FormulaBar(
      host.querySelector<HTMLFormElement>(".formula-bar")!,
      {
        onCreate: async (path, expression) => {
          host.dataset.created = `${path}|${expression}`;
        },
        onClose: () => {
          host.dataset.closed = "true";
        },
      },
    );
    bar.setOpen(true);
  });

  const host = page.locator("#formula-probe");
  const input = host.locator(".formula-input");
  await input.fill("derived/double = 'demo/x' * 2");
  await input.press("Enter");
  await expect(host).toHaveAttribute(
    "data-created",
    "derived/double|'demo/x' * 2",
  );
  await expect(input).toHaveValue("");
  await input.press("ArrowUp");
  await expect(input).toHaveValue("derived/double = 'demo/x' * 2");
});
```

- [ ] **Step 2: Run E2E to verify red**

```bash
./scripts/test.sh e2e
```

Expected: the dynamic import of `formula-bar.ts` fails because the component
does not exist.

- [ ] **Step 3: Create the component with current behavior**

Create `formula-bar.ts` with:

```ts
import { parseFormulaInput } from "../app/formula";
import { required } from "./dom";

export interface FormulaBarCallbacks {
  onCreate(path: string, expression: string): Promise<void>;
  onClose(): void;
}

export class FormulaBar {
  private readonly input: HTMLInputElement;
  private readonly error: HTMLElement;
  private history: string[] = [];
  private historyIndex = 0;
  private derivedCounter = 0;

  constructor(
    private readonly element: HTMLFormElement,
    private readonly callbacks: FormulaBarCallbacks,
  ) {
    this.input = required(element, ".formula-input");
    this.error = required(element, ".formula-error");
    element.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.submit();
    });
    this.input.addEventListener("keydown", (event) => {
      this.onKeyDown(event);
    });
  }

  setOpen(open: boolean): void {
    if (open) this.input.focus();
    else this.input.blur();
  }

  setSignals(_paths: readonly string[]): void {}

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      this.callbacks.onClose();
      return;
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    if (this.history.length === 0) return;
    event.preventDefault();
    const step = event.key === "ArrowUp" ? -1 : 1;
    this.historyIndex = clampIndex(
      this.historyIndex + step,
      this.history.length,
    );
    this.input.value = this.history[this.historyIndex] ?? this.input.value;
  }

  private async submit(): Promise<void> {
    this.derivedCounter += 1;
    const parsed = parseFormulaInput(this.input.value, this.derivedCounter);
    if (parsed === null) {
      this.derivedCounter -= 1;
      return;
    }
    try {
      await this.callbacks.onCreate(parsed.path, parsed.expr);
      this.history.push(this.input.value.trim());
      this.historyIndex = this.history.length;
      this.input.value = "";
      this.error.hidden = true;
      this.error.textContent = "";
    } catch (failure: unknown) {
      this.derivedCounter -= 1;
      this.error.textContent =
        failure instanceof Error ? failure.message : String(failure);
      this.error.hidden = false;
    }
  }
}

function clampIndex(index: number, length: number): number {
  return Math.min(Math.max(index, 0), length);
}

export function formulaBarMarkup(): string {
  return `<form class="formula-bar" id="formula-editor">
    <span class="formula-mark">ƒx</span>
    <input class="formula-input" aria-label="Derived signal formula" placeholder="derived/name = expression" spellcheck="false" />
    <span class="formula-error" role="alert" hidden></span>
  </form>`;
}
```

Task 4 replaces the no-op `setSignals` with stored paths when help first needs
them.

- [ ] **Step 4: Wire `AppShell` to the component**

Before editing, locate every formula field and listener:

```bash
rg -n "formulaHistory|formulaHistoryIndex|derivedCounter|submitFormula|formula-bar|setFormulaOpen|reloadSignals" frontend/src/ui/app-shell.ts
```

Then:

- import `FormulaBar` and `formulaBarMarkup`;
- add `private formulaBar: FormulaBar | null = null;`;
- remove `formulaHistory`, `formulaHistoryIndex`, `derivedCounter`,
  `submitFormula`, and module-level `clampIndex`;
- instantiate the component before `bindControls()`:

```ts
this.formulaBar = new FormulaBar(required(this.root, ".formula-bar"), {
  onCreate: (path, expression) => this.createDerived(path, expression),
  onClose: () => {
    this.setFormulaOpen(false);
  },
});
```

- remove the old form submit and input keydown listeners from `bindControls`;
- replace the literal form in `shellMarkup()` with `${formulaBarMarkup()}`;
- update `setFormulaOpen`:

```ts
this.formulaBar?.setOpen(open);
```

instead of directly focusing or blurring the input;

- update `reloadSignals` after `this.tree?.setSignals(...)`:

```ts
this.formulaBar?.setSignals(this.signals.map((summary) => summary.path));
```

- [ ] **Step 5: Verify extraction behavior**

```bash
./scripts/test.sh frontend
./scripts/test.sh e2e
```

Expected: existing formula parsing tests, snapshot hiding, and the new direct
component test all pass.

- [ ] **Step 6: Format and commit**

```bash
./scripts/format.sh
git add frontend/src/ui/formula-bar.ts frontend/src/ui/app-shell.ts frontend/tests/e2e/workbench.spec.ts
git diff --cached --check
git commit -m "refactor(ui): isolate the derived formula bar" -m "The component owns editor state while AppShell retains the single derived creation path."
```

---

### Task 4: First-use help and actionable errors

**Files:**

- Modify: `frontend/src/ui/formula-bar.ts`
- Modify: `frontend/src/styles/app.css`
- Modify: `frontend/tests/e2e/workbench.spec.ts`

**Interfaces:**

- Consumes: `FormulaBar.setOpen` and `FormulaBar.setSignals`.
- Produces:
  - local preference key `signalscope.formulaHelpSeen`
  - `.formula-help-button`, `.formula-help-popover`,
    `.formula-help-example`, and `.formula-error-guidance`

- [ ] **Step 1: Add failing first-use help tests**

Add a second direct-component test. Clear storage before constructing it:

```ts
test("formula help teaches real paths once and remains available", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    localStorage.removeItem("signalscope.formulaHelpSeen");
    const modulePath = "/src/ui/formula-bar.ts";
    const { FormulaBar, formulaBarMarkup } = (await import(
      /* @vite-ignore */ modulePath
    )) as {
      FormulaBar: typeof FormulaBarClass;
      formulaBarMarkup: () => string;
    };
    const host = document.createElement("div");
    host.id = "formula-help-probe";
    host.innerHTML = formulaBarMarkup();
    document.body.replaceChildren(host);
    const bar = new FormulaBar(
      host.querySelector<HTMLFormElement>(".formula-bar")!,
      {
        onCreate: async () => {},
        onClose: () => {},
      },
    );
    bar.setSignals(["demo_flight/attitude/pitch_deg"]);
    bar.setOpen(true);
  });

  const host = page.locator("#formula-help-probe");
  const help = host.locator(".formula-help-popover");
  await expect(help).toBeVisible();
  await expect(help.locator(".formula-help-example")).toContainText(
    "'demo_flight/attitude/pitch_deg'",
  );
  const button = host.getByRole("button", { name: "Formula help" });
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await button.click();
  await expect(help).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("signalscope.formulaHelpSeen")),
    )
    .toBe("1");
  await button.click();
  await expect(help).toBeVisible();
  await button.focus();
  await page.keyboard.press("Escape");
  await expect(help).toBeHidden();
  await button.press("Enter");
  await expect(help).toBeVisible();
});
```

Extend the component creation test's callback to reject one formula, submit
it, and assert:

```ts
onCreate: async (path, expression) => {
  if (path === "derived/bad") throw new Error("unknown signal \"missing/path\"");
  host.dataset.created = `${path}|${expression}`;
},
```

Then:

```ts
await input.fill("derived/bad = 'missing/path'");
await input.press("Enter");
await expect(host.locator(".formula-error")).toContainText("unknown signal");
await expect(host.locator(".formula-error-guidance")).toHaveText(
  "Signal references use quoted full paths. Drag from the tree to insert.",
);
await expect(input).toHaveValue("derived/bad = 'missing/path'");
```

- [ ] **Step 2: Run E2E to verify red**

```bash
./scripts/test.sh e2e
```

Expected: help and guidance selectors are absent.

- [ ] **Step 3: Extend the component markup**

Use this structure inside `formulaBarMarkup()`:

```html
<form class="formula-bar" id="formula-editor">
  <span class="formula-mark">ƒx</span>
  <input
    class="formula-input"
    aria-label="Derived signal formula"
    placeholder="derived/name = expression · drop signals here"
    spellcheck="false"
  />
  <span class="formula-error" role="alert" hidden></span>
  <span class="formula-error-guidance" hidden>
    Signal references use quoted full paths. Drag from the tree to insert.
  </span>
  <button
    type="button"
    class="formula-help-button"
    aria-label="Formula help"
    aria-controls="formula-help"
    aria-expanded="false"
  >
    ?
  </button>
  <div
    class="formula-help-popover"
    id="formula-help"
    role="dialog"
    aria-label="Derived formula help"
    hidden
  >
    <strong>Derived formulas</strong>
    <code>derived/name = expression</code>
    <span>Signals use quoted full paths. Drag from the tree to insert.</span>
    <code class="formula-help-example"></code>
    <code>gradient(x) · cumtrapz(x) · movmean(x, 51)</code>
    <code>abs(x) · hypot(x, y)</code>
    <span>↵ create · ↑/↓ history · esc close · ctrl+space complete</span>
  </div>
</form>
```

- [ ] **Step 4: Implement help state and real examples**

In `FormulaBar`:

- add `quoteSignalPath` to the existing `../app/formula` import;
- capture the help button, popover, example, and guidance elements;
- bind the button to `toggleHelp`;
- make `setSignals` call `renderHelpExample`;
- make `setOpen(true)` open help only when the preference is absent;
- make `setOpen(false)` close and remember help before blurring;
- make closing help persist `"1"`.
- when help is open, route Escape from the input or help button to close only
  the popover; a later Escape closes the formula bar.

Add `private signals: readonly string[] = [];` and make `setSignals` store a
copy before rendering the example.

Use guarded storage:

```ts
const HELP_SEEN_KEY = "signalscope.formulaHelpSeen";

function helpWasSeen(): boolean {
  try {
    return localStorage.getItem(HELP_SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberHelp(): void {
  try {
    localStorage.setItem(HELP_SEEN_KEY, "1");
  } catch {
    // file:// snapshots and locked-down webviews may reject storage.
  }
}
```

Render the example only through `textContent`:

```ts
private renderHelpExample(): void {
  const first = this.signals[0];
  this.helpExample.textContent =
    first === undefined
      ? "Load a source, then drag signals here."
      : `derived/result = ${quoteSignalPath(first)}`;
}
```

On submit failure, show both error and guidance. On successful creation, hide
and clear both. Do not inspect the backend error string.

- [ ] **Step 5: Add flat popover styles**

Add beside the formula styles:

```css
.formula-bar {
  position: relative;
}

.formula-help-button {
  width: 20px;
  height: 20px;
  border: 1px solid var(--border-strong);
  border-radius: 2px;
  color: var(--fg-2);
  font: 10.5px var(--font-mono);
}

.formula-help-button:hover,
.formula-help-button[aria-expanded="true"] {
  background: var(--surface-3);
  color: var(--fg-1);
}

.formula-help-popover {
  position: absolute;
  right: 8px;
  bottom: calc(100% + 4px);
  z-index: 6;
  display: grid;
  width: 360px;
  gap: 6px;
  padding: 10px;
  border: 1px solid var(--border-strong);
  border-radius: 2px;
  background: var(--surface-2);
  color: var(--fg-3);
  font-size: 10.5px;
}

.formula-help-popover code {
  color: var(--fg-1);
  font-family: var(--font-mono);
}

.formula-help-popover[hidden],
.formula-error-guidance[hidden] {
  display: none;
}

.formula-error-guidance {
  color: var(--fg-3);
  font-size: 10px;
}
```

- [ ] **Step 6: Verify, format, and commit**

```bash
./scripts/test.sh frontend
./scripts/test.sh e2e
./scripts/format.sh
git add frontend/src/ui/formula-bar.ts frontend/src/styles/app.css frontend/tests/e2e/workbench.spec.ts
git diff --cached --check
git commit -m "feat(ui): teach derived formula syntax in place" -m "First-use help uses a loaded path, stays reopenable, and pairs failures with stable drag guidance."
```

---

### Task 5: Signal-tree drops into the formula

**Files:**

- Modify: `frontend/src/ui/formula-bar.ts`
- Modify: `frontend/src/styles/app.css`
- Modify: `frontend/tests/e2e/workbench.spec.ts`

**Interfaces:**

- Consumes:
  - `SIGNAL_DRAG_TYPE` from `frontend/src/ui/panel.ts`
  - `insertSignalReference(...)`
- Produces: formula-bar dragover/drop handling using the existing tree payload.

- [ ] **Step 1: Add the failing drag insertion E2E**

Extend the help probe test after closing help:

```ts
const input = host.locator(".formula-input");
await input.fill("derived/sum = hypot(, )");
await input.evaluate((element: HTMLInputElement) => {
  element.setSelectionRange(20, 20);
});

const firstTransfer = await page.evaluateHandle(() => {
  const transfer = new DataTransfer();
  transfer.setData(
    "application/x-signalscope-signal",
    "demo_flight/attitude/pitch_deg",
  );
  return transfer;
});
const bar = host.locator(".formula-bar");
await bar.dispatchEvent("dragover", { dataTransfer: firstTransfer });
await expect(bar).toHaveClass(/drop-target/);
await bar.dispatchEvent("drop", { dataTransfer: firstTransfer });
await expect(input).toHaveValue(
  "derived/sum = hypot('demo_flight/attitude/pitch_deg', )",
);
await expect(input).toBeFocused();
await expect(bar).not.toHaveClass(/drop-target/);
```

Then set the caret before `)` and drop a second path, asserting both quoted
references remain:

```ts
await input.evaluate((element: HTMLInputElement) => {
  const close = element.value.lastIndexOf(")");
  element.setSelectionRange(close, close);
});
const secondTransfer = await page.evaluateHandle(() => {
  const transfer = new DataTransfer();
  transfer.setData(
    "application/x-signalscope-signal",
    "demo_flight/attitude/roll_deg",
  );
  return transfer;
});
await bar.dispatchEvent("drop", { dataTransfer: secondTransfer });
await expect(input).toHaveValue(
  "derived/sum = hypot('demo_flight/attitude/pitch_deg', 'demo_flight/attitude/roll_deg')",
);
```

- [ ] **Step 2: Run E2E to verify red**

```bash
./scripts/test.sh e2e
```

Expected: the dragover is not accepted and no text is inserted.

- [ ] **Step 3: Bind the existing drag payload**

Import:

```ts
import {
  insertSignalReference,
  parseFormulaInput,
  quoteSignalPath,
} from "../app/formula";
import { SIGNAL_DRAG_TYPE } from "./panel";
```

In the constructor, add:

```ts
element.addEventListener("dragover", (event) => {
  if (event.dataTransfer?.types.includes(SIGNAL_DRAG_TYPE) !== true) return;
  event.preventDefault();
  element.classList.add("drop-target");
});
element.addEventListener("dragleave", (event) => {
  if (!element.contains(event.relatedTarget as Node | null)) {
    element.classList.remove("drop-target");
  }
});
element.addEventListener("drop", (event) => {
  const path = event.dataTransfer?.getData(SIGNAL_DRAG_TYPE);
  element.classList.remove("drop-target");
  if (path === undefined || path === "") return;
  event.preventDefault();
  const start = this.input.selectionStart ?? this.input.value.length;
  const end = this.input.selectionEnd ?? start;
  const edit = insertSignalReference(this.input.value, path, start, end);
  this.input.value = edit.text;
  this.input.focus();
  this.input.setSelectionRange(edit.caret, edit.caret);
  this.input.dispatchEvent(new Event("input", { bubbles: true }));
});
```

- [ ] **Step 4: Style only the active drop target**

```css
.formula-bar.drop-target {
  outline: 1px solid var(--amber-7);
  outline-offset: -1px;
  background: var(--amber-3);
}
```

- [ ] **Step 5: Verify the complete Stage 1 checkpoint**

```bash
./scripts/test.sh frontend
./scripts/test.sh e2e
./scripts/format.sh
git add frontend/src/ui/formula-bar.ts frontend/src/styles/app.css frontend/tests/e2e/workbench.spec.ts
git diff --cached --check
git commit -m "feat(ui): drop tree signals into formulas" -m "Each drop inserts one safely quoted full path at the caret so multi-signal expressions compose naturally."
```

At this checkpoint, run the native app manually if available and confirm a
tree leaf can be dropped twice into `hypot(, )`. Do not claim this manual check
if it was not performed.

---

### Task 6: Context-sensitive completion model

**Files:**

- Create: `frontend/src/app/formula-completion.ts`
- Create: `frontend/src/app/formula-completion.test.ts`
- Modify: `frontend/src/app/formula.ts`
- Modify: `frontend/src/app/formula.test.ts`

**Interfaces:**

- Consumes: `quoteSignalPath`.
- Produces:

```ts
export type CompletionKind = "function" | "constant" | "time" | "signal";

export interface CompletionContext {
  source: "language" | "signal";
  query: string;
  start: number;
  end: number;
}

export interface FormulaCompletion {
  kind: CompletionKind;
  label: string;
  detail: string;
  replacement: string;
  caretOffset: number;
}

export function completionContext(
  text: string,
  caret: number,
  manual: boolean,
): CompletionContext | null;

export function formulaCompletions(
  context: CompletionContext,
  signalPaths: readonly string[],
): FormulaCompletion[];

export function applyCompletion(
  text: string,
  context: CompletionContext,
  completion: FormulaCompletion,
): FormulaEdit;
```

- [ ] **Step 1: Expose the assignment separator for context detection**

Refactor `formula.ts` so its current separator loop becomes:

```ts
export function formulaAssignmentSeparator(text: string): number {
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote !== null) {
      if (character !== quote) continue;
      if (text[index + 1] === quote) {
        index += 1;
        continue;
      }
      quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (text[index] !== "=") continue;
    if (text[index + 1] === "=") {
      index += 1;
      continue;
    }
    if (["=", "~", "<", ">"].includes(text[index - 1] ?? "")) continue;
    return index;
  }
  return -1;
}
```

Make `parseFormulaInput` call this helper. Extend its equality test to assert:

```ts
expect(formulaAssignmentSeparator("derived/x = 'a/x' == 2")).toBe(10);
expect(formulaAssignmentSeparator("'a/x' >= 2")).toBe(-1);
expect(formulaAssignmentSeparator("'a=x' * 2")).toBe(-1);
```

- [ ] **Step 2: Write failing completion-context tests**

Create `formula-completion.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  applyCompletion,
  completionContext,
  formulaCompletions,
} from "./formula-completion";

describe("completionContext", () => {
  it("completes identifiers only on the expression side", () => {
    expect(completionContext("derived/x = gra", 15, false)).toEqual({
      source: "language",
      query: "gra",
      start: 12,
      end: 15,
    });
    expect(completionContext("derived/gra = 'a/x'", 11, true)).toBeNull();
  });

  it("searches inside either quote style", () => {
    expect(completionContext("derived/x = 'pitch", 18, false)).toEqual({
      source: "signal",
      query: "pitch",
      start: 12,
      end: 18,
    });
    expect(completionContext('derived/x = "att', 16, false)).toEqual({
      source: "signal",
      query: "att",
      start: 12,
      end: 16,
    });
  });

  it("opens an empty language list only when requested", () => {
    expect(completionContext("derived/x = ", 12, false)).toBeNull();
    expect(completionContext("derived/x = ", 12, true)).toEqual({
      source: "language",
      query: "",
      start: 12,
      end: 12,
    });
  });
});

describe("formulaCompletions", () => {
  it("ranks prefix signal matches before substring matches and caps results", () => {
    const signals = [
      "demo/pitch_rate",
      "demo/target_pitch",
      ...Array.from({ length: 60 }, (_, index) => `other/value_${index}_pitch`),
    ];
    const context = {
      source: "signal" as const,
      query: "pitch",
      start: 0,
      end: 0,
    };
    const matches = formulaCompletions(context, signals);
    expect(matches[0]?.label).toBe("demo/pitch_rate");
    expect(matches[1]?.label).toBe("demo/target_pitch");
    expect(matches).toHaveLength(50);
  });

  it("describes language entries and applies call shapes", () => {
    const context = {
      source: "language" as const,
      query: "mov",
      start: 12,
      end: 15,
    };
    const completion = formulaCompletions(context, [])[0]!;
    expect(completion).toMatchObject({
      label: "movmean",
      detail: "moving mean",
      replacement: "movmean(, 51)",
    });
    expect(applyCompletion("derived/x = mov", context, completion)).toEqual({
      text: "derived/x = movmean(, 51)",
      caret: 20,
    });
  });
});
```

- [ ] **Step 3: Run frontend tests to verify red**

```bash
./scripts/test.sh frontend
```

Expected: the new module and assignment helper exports are missing.

- [ ] **Step 4: Implement context detection**

Create `formula-completion.ts` with:

```ts
import {
  formulaAssignmentSeparator,
  quoteSignalPath,
  type FormulaEdit,
} from "./formula";
```

Context detection must:

1. clamp the caret;
2. use `formulaAssignmentSeparator` to reject the assignment's left side;
3. scan from the expression start through the caret, tracking `'` or `"` and
   treating doubled matching delimiters as escaped;
4. return a signal range beginning at its opening delimiter when a quote is
   active;
5. otherwise return the ASCII identifier prefix before the caret;
6. return an empty language context only for `manual === true`.

The signal replacement range extends through an existing closing delimiter
when present, so accepting a suggestion never leaves an extra quote.

Implement it as:

```ts
export function completionContext(
  text: string,
  caret: number,
  manual: boolean,
): CompletionContext | null {
  const at = Math.min(Math.max(caret, 0), text.length);
  const separator = formulaAssignmentSeparator(text);
  if (separator >= 0 && at <= separator) return null;
  const expressionStart = separator >= 0 ? separator + 1 : 0;

  let quote: "'" | '"' | null = null;
  let quoteStart = -1;
  for (let index = expressionStart; index < at; index += 1) {
    const character = text[index];
    if (quote === null) {
      if (character === "'" || character === '"') {
        quote = character;
        quoteStart = index;
      }
      continue;
    }
    if (character !== quote) continue;
    if (text[index + 1] === quote && index + 1 < at) {
      index += 1;
      continue;
    }
    quote = null;
    quoteStart = -1;
  }

  if (quote !== null) {
    let end = at;
    for (let index = at; index < text.length; index += 1) {
      if (text[index] !== quote) continue;
      if (text[index + 1] === quote) {
        index += 1;
        continue;
      }
      end = index + 1;
      break;
    }
    return {
      source: "signal",
      query: text
        .slice(quoteStart + 1, at)
        .replaceAll(`${quote}${quote}`, quote),
      start: quoteStart,
      end,
    };
  }

  let start = at;
  while (
    start > expressionStart &&
    /[A-Za-z0-9_]/.test(text[start - 1] ?? "")
  ) {
    start -= 1;
  }
  if (start < at && /[A-Za-z_]/.test(text[start] ?? "")) {
    return {
      source: "language",
      query: text.slice(start, at),
      start,
      end: at,
    };
  }
  return manual ? { source: "language", query: "", start: at, end: at } : null;
}
```

- [ ] **Step 5: Implement the language catalog and ranking**

Use this exact catalog:

```ts
const LANGUAGE = [
  ["abs", "absolute value", "abs()", 4],
  ["sqrt", "square root", "sqrt()", 5],
  ["exp", "natural exponential", "exp()", 4],
  ["log", "natural logarithm", "log()", 4],
  ["log2", "base-2 logarithm", "log2()", 5],
  ["log10", "base-10 logarithm", "log10()", 6],
  ["sin", "sine", "sin()", 4],
  ["cos", "cosine", "cos()", 4],
  ["tan", "tangent", "tan()", 4],
  ["asin", "inverse sine", "asin()", 5],
  ["acos", "inverse cosine", "acos()", 5],
  ["atan", "inverse tangent", "atan()", 5],
  ["atan2", "two-argument arctangent", "atan2(, )", 6],
  ["sinh", "hyperbolic sine", "sinh()", 5],
  ["cosh", "hyperbolic cosine", "cosh()", 5],
  ["tanh", "hyperbolic tangent", "tanh()", 5],
  ["hypot", "Euclidean magnitude", "hypot(, )", 6],
  ["floor", "round toward negative infinity", "floor()", 6],
  ["ceil", "round toward positive infinity", "ceil()", 5],
  ["round", "round to nearest integer", "round()", 6],
  ["fix", "round toward zero", "fix()", 4],
  ["sign", "signum", "sign()", 5],
  ["mod", "floor remainder", "mod(, )", 4],
  ["rem", "truncated remainder", "rem(, )", 4],
  ["min", "minimum", "min(, )", 4],
  ["max", "maximum", "max(, )", 4],
  ["power", "element-wise power", "power(, )", 6],
  ["gradient", "time derivative", "gradient()", 9],
  ["cumtrapz", "cumulative trapezoidal integral", "cumtrapz()", 9],
  ["movmean", "moving mean", "movmean(, 51)", 8],
  ["pi", "circle constant", "pi", 2],
  ["Inf", "positive infinity", "Inf", 3],
  ["NaN", "not a number", "NaN", 3],
  ["eps", "machine epsilon", "eps", 3],
  ["t", "sample time", "t", 1],
] as const;
```

The fourth tuple item is the caret offset from the start of the replacement.
Classify `t` as `"time"`, constants as `"constant"`, and the rest as
`"function"`.

For both language and signal entries:

- compare lowercased labels to a lowercased query;
- discard non-matches;
- treat either a full-path prefix or a final-path-segment prefix as a prefix
  match;
- sort prefix matches before substring matches, then by label;
- return at most 50 entries.

Signal replacements use `quoteSignalPath(path)` and place the caret at the end.

Implement ranking with:

```ts
function matchRank(label: string, query: string): number | null {
  const candidate = label.toLowerCase();
  const needle = query.toLowerCase();
  if (needle === "") return 0;
  const short = candidate.split("/").at(-1) ?? candidate;
  if (candidate.startsWith(needle) || short.startsWith(needle)) return 0;
  return candidate.includes(needle) ? 1 : null;
}

export function formulaCompletions(
  context: CompletionContext,
  signalPaths: readonly string[],
): FormulaCompletion[] {
  const entries =
    context.source === "signal"
      ? signalPaths.map((path) => {
          const replacement = quoteSignalPath(path);
          return {
            kind: "signal" as const,
            label: path,
            detail: "signal",
            replacement,
            caretOffset: replacement.length,
          };
        })
      : LANGUAGE.map(([label, detail, replacement, caretOffset]) => ({
          kind:
            label === "t"
              ? ("time" as const)
              : ["pi", "Inf", "NaN", "eps"].includes(label)
                ? ("constant" as const)
                : ("function" as const),
          label,
          detail,
          replacement,
          caretOffset,
        }));

  return entries
    .map((entry) => ({ entry, rank: matchRank(entry.label, context.query) }))
    .filter(
      (match): match is { entry: FormulaCompletion; rank: number } =>
        match.rank !== null,
    )
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        left.entry.label.localeCompare(right.entry.label),
    )
    .slice(0, 50)
    .map((match) => match.entry);
}
```

- [ ] **Step 6: Implement completion application**

```ts
export function applyCompletion(
  text: string,
  context: CompletionContext,
  completion: FormulaCompletion,
): FormulaEdit {
  return {
    text:
      text.slice(0, context.start) +
      completion.replacement +
      text.slice(context.end),
    caret: context.start + completion.caretOffset,
  };
}
```

- [ ] **Step 7: Verify, format, and commit**

```bash
./scripts/test.sh frontend
./scripts/format.sh
git add frontend/src/app/formula.ts frontend/src/app/formula.test.ts frontend/src/app/formula-completion.ts frontend/src/app/formula-completion.test.ts
git diff --cached --check
git commit -m "feat(formula): model context-sensitive completion" -m "Pure context, ranking, and replacement helpers keep the editor UI independent of expression semantics."
```

---

### Task 7: Completion popup and keyboard routing

**Files:**

- Modify: `frontend/src/ui/formula-bar.ts`
- Modify: `frontend/src/styles/app.css`
- Modify: `frontend/tests/e2e/workbench.spec.ts`

**Interfaces:**

- Consumes:
  - `completionContext`
  - `formulaCompletions`
  - `applyCompletion`
- Produces an accessible `.formula-completions[role=listbox]` owned by
  `FormulaBar`.

- [ ] **Step 1: Add failing context-sensitive completion E2E**

In the direct formula probe:

```ts
await input.fill("derived/rate = gra");
await expect(host.locator(".formula-completions")).toBeVisible();
await expect(
  host.getByRole("option", { name: /gradient.*time derivative/ }),
).toBeVisible();
await input.press("Enter");
await expect(input).toHaveValue("derived/rate = gradient()");
await expect(input).toBeFocused();

await input.fill("derived/rate = 'pitch");
await expect(
  host.getByRole("option", {
    name: /demo_flight\/attitude\/pitch_deg/,
  }),
).toBeVisible();
await input.press("Tab");
await expect(input).toHaveValue(
  "derived/rate = 'demo_flight/attitude/pitch_deg'",
);

await input.fill("derived/root = sq");
await host.getByRole("option", { name: /sqrt.*square root/ }).click();
await expect(input).toHaveValue("derived/root = sqrt()");
await expect(input).toBeFocused();
```

Update the probe setup before `bar.setOpen(true)` so signal completion has a
real index:

```ts
bar.setSignals([
  "demo_flight/attitude/pitch_deg",
  "demo_flight/attitude/roll_deg",
]);
```

Add keyboard routing assertions:

```ts
await input.fill("derived/x = ");
await input.press("Control+Space");
await expect(host.locator(".formula-completions")).toBeVisible();
await input.press("Escape");
await expect(host.locator(".formula-completions")).toBeHidden();
await expect(host).not.toHaveAttribute("data-closed", "true");
await input.press("Escape");
await expect(host).toHaveAttribute("data-closed", "true");
```

- [ ] **Step 2: Run E2E to verify red**

```bash
./scripts/test.sh e2e
```

Expected: no listbox or options appear.

- [ ] **Step 3: Add accessible completion markup**

Update the input:

```html
<input
  class="formula-input"
  role="combobox"
  aria-label="Derived signal formula"
  aria-autocomplete="list"
  aria-controls="formula-completions"
  aria-expanded="false"
  placeholder="derived/name = expression · drop signals here"
  spellcheck="false"
/>
```

Add after the help popover:

```html
<div
  class="formula-completions"
  id="formula-completions"
  role="listbox"
  aria-label="Formula suggestions"
  hidden
></div>
```

- [ ] **Step 4: Render completion from the active context**

Import:

```ts
import {
  applyCompletion,
  completionContext,
  formulaCompletions,
  type CompletionContext,
  type FormulaCompletion,
} from "../app/formula-completion";
```

Add component state:

```ts
private completionContext: CompletionContext | null = null;
private completions: FormulaCompletion[] = [];
private completionIndex = 0;
```

On `input`, call `refreshCompletions(false)`. On `Ctrl+Space`, prevent default
and call `refreshCompletions(true)`.

Opening completion closes and remembers first-use help so the two popovers
never overlap. Opening formula help clears completion.
`setOpen(false)` also clears completion.

`refreshCompletions` reads `selectionStart`, builds context and entries, clears
when either is absent, and renders each option with DOM APIs:

```ts
const option = document.createElement("button");
option.type = "button";
option.className = "formula-completion";
option.id = `formula-completion-${String(index)}`;
option.tabIndex = -1;
option.setAttribute("role", "option");
option.setAttribute("aria-selected", String(index === this.completionIndex));

const label = document.createElement("code");
label.textContent = completion.label;
const detail = document.createElement("span");
detail.textContent = completion.detail;
option.append(label, detail);
option.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  this.completionIndex = index;
  this.acceptCompletion();
});
```

Using `pointerdown` with `preventDefault()` before acceptance keeps a click
from stealing input focus.

Keep `aria-expanded` and `aria-activedescendant` synchronized. Clearing
completion removes all options and hides the listbox.

Use these state transitions:

```ts
private refreshCompletions(manual: boolean): void {
  const caret = this.input.selectionStart ?? this.input.value.length;
  const context = completionContext(this.input.value, caret, manual);
  const completions =
    context === null ? [] : formulaCompletions(context, this.signals);
  if (context === null || completions.length === 0) {
    this.clearCompletions();
    return;
  }
  this.closeHelp();
  this.completionContext = context;
  this.completions = completions;
  this.completionIndex = 0;
  this.renderCompletions();
}

private clearCompletions(): void {
  this.completionContext = null;
  this.completions = [];
  this.completionIndex = 0;
  this.completionList.replaceChildren();
  this.completionList.hidden = true;
  this.input.ariaExpanded = "false";
  this.input.removeAttribute("aria-activedescendant");
}

private acceptCompletion(): void {
  const context = this.completionContext;
  const completion = this.completions[this.completionIndex];
  if (context === null || completion === undefined) return;
  const edit = applyCompletion(this.input.value, context, completion);
  this.input.value = edit.text;
  this.clearCompletions();
  this.input.focus();
  this.input.setSelectionRange(edit.caret, edit.caret);
}
```

- [ ] **Step 5: Route completion keys before history and submit**

At the start of `onKeyDown`:

- `Ctrl+Space` manually opens completion;
- when completion is open, Up/Down wrap the selected index;
- Enter or Tab accepts the active item and does not submit;
- Escape clears completion and returns.

Use this ordering before the existing help, Escape-close, and history cases:

```ts
if (event.ctrlKey && event.code === "Space") {
  event.preventDefault();
  this.refreshCompletions(true);
  return;
}
if (this.completions.length > 0) {
  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    event.preventDefault();
    const step = event.key === "ArrowUp" ? -1 : 1;
    this.completionIndex =
      (this.completionIndex + step + this.completions.length) %
      this.completions.length;
    this.renderCompletions();
    return;
  }
  if (event.key === "Enter" || event.key === "Tab") {
    event.preventDefault();
    this.acceptCompletion();
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    this.clearCompletions();
    return;
  }
}
```

Only after those cases run the existing Escape-close and history logic.

Acceptance applies the pure edit, updates the input and selection, focuses it,
and clears completion. Dropped text already dispatches `input`, so it uses the
same refresh path.

- [ ] **Step 6: Style the bounded popup**

```css
.formula-completions {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 28px;
  z-index: 7;
  width: min(440px, calc(100% - 72px));
  max-height: 240px;
  overflow-y: auto;
  border: 1px solid var(--border-strong);
  border-radius: 2px;
  background: var(--surface-2);
}

.formula-completions[hidden] {
  display: none;
}

.formula-completion {
  display: flex;
  width: 100%;
  justify-content: space-between;
  gap: 12px;
  padding: 5px 8px;
  color: var(--fg-3);
  text-align: left;
}

.formula-completion code {
  color: var(--fg-1);
  font-family: var(--font-mono);
}

.formula-completion[aria-selected="true"],
.formula-completion:hover {
  background: var(--surface-3);
}
```

- [ ] **Step 7: Verify, format, and commit**

```bash
./scripts/test.sh frontend
./scripts/test.sh e2e
./scripts/format.sh
git add frontend/src/ui/formula-bar.ts frontend/src/styles/app.css frontend/tests/e2e/workbench.spec.ts
git diff --cached --check
git commit -m "feat(ui): complete formula functions and signals" -m "The combobox routes keys by context while preserving creation, history, and drag workflows when suggestions are closed."
```

---

### Task 8: User documentation and full gate

**Files:**

- Modify: `README.md`
- Modify: `docs/Signal Scope UI Design Pass/design_handoff_signalscope_ui/README.md`

**Interfaces:**

- Consumes the finished onboarding surface.
- Produces accurate repository and design-handoff syntax documentation.

- [ ] **Step 1: Replace the stale design-handoff syntax**

Confirm the current line:

```bash
rg -n "Transforms: docked formula bar" "docs/Signal Scope UI Design Pass/design_handoff_signalscope_ui/README.md"
```

Replace the JavaScript/prototype spelling with:

```text
Transforms: docked formula bar — `derived/name = expr`, quoted full-path
references (`'source/group/signal'`), `gradient`/`cumtrapz`/`movmean`, MATLAB
operators and scalar functions; ↵ create, ↑/↓ history, ctrl+space complete,
esc collapse. Drag tree signals into the bar to insert references. Quick
transforms are duplicated in the legend inspector.
```

- [ ] **Step 2: Add a concise derived-signal section to the main README**

After the demo-flight paragraph, add:

````markdown
### Derived signals

Press `E` to open the formula bar. Signal references use their quoted full
tree path; drag leaves from the signal tree to insert them:

```text
derived/pitch_twice = 'demo_flight/attitude/pitch_deg' * 2
derived/speed = hypot('demo_flight/velocity_body/x_mps', 'demo_flight/velocity_body/y_mps')
```

Press `?` in the bar for syntax help or `Ctrl+Space` for context-sensitive
function and signal completion. Enter creates, Up/Down recalls accepted
formulas, and Escape closes the bar.
````

Before committing, confirm the exact demo paths from
`examples/demo_flight.csv`; correct the example if its headers differ:

```bash
sed -n '1,6p' examples/demo_flight.csv
```

- [ ] **Step 3: Run the full verification gate**

```bash
./scripts/format.sh
./scripts/test.sh full
./scripts/ci.sh all
```

Expected:

- Rust core, protocol, and shell tests pass;
- frontend lint, codegen check, unit tests, build, and snapshot artifact checks
  pass;
- Playwright passes, including the direct FormulaBar probe and the null-derived
  BakedPlane assertion;
- formatting, spelling, dependency, workflow, and unused-code gates pass.

- [ ] **Step 4: Review the final diff and worktree**

```bash
git diff --check
git status --short
git diff -- README.md "docs/Signal Scope UI Design Pass/design_handoff_signalscope_ui/README.md"
```

Only the two documentation files should remain unstaged at this point.

- [ ] **Step 5: Commit**

```bash
git add README.md "docs/Signal Scope UI Design Pass/design_handoff_signalscope_ui/README.md"
git diff --cached --check
git commit -m "docs: explain derived formula workflows" -m "The repository and design handoff now teach quoted paths, tree drops, completion, and current MATLAB transform names."
```

- [ ] **Step 6: Record the checkpoint**

```bash
git status --short
git log --oneline -9
```

The worktree must be clean. Hand the user the native test checkpoint and do not
start durable-session Tasks 12–19 until they accept the formula workflow.
