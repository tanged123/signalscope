import {
  insertSignalReference,
  parseFormulaInput,
  quoteSignalPath,
} from "../app/formula";
import {
  applyCompletion,
  completionContext,
  formulaCompletions,
  type CompletionContext,
  type FormulaCompletion,
} from "../app/formula-completion";
import { required } from "./dom";
import { SIGNAL_DRAG_TYPE } from "./panel";

const HELP_SEEN_KEY = "signalscope.formulaHelpSeen";
const ERROR_GUIDANCE =
  "Signal references use quoted full paths. Drag from the tree to insert.";

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

export interface FormulaBarCallbacks {
  onCreate(path: string, expression: string): Promise<void>;
  onClose(): void;
}

export class FormulaBar {
  private readonly input: HTMLInputElement;
  private readonly error: HTMLElement;
  private readonly errorGuidance: HTMLElement;
  private readonly helpButton: HTMLButtonElement;
  private readonly helpPopover: HTMLElement;
  private readonly helpExample: HTMLElement;
  private readonly completionList: HTMLElement;
  private signals: readonly string[] = [];
  private history: string[] = [];
  private historyIndex = 0;
  private derivedCounter = 0;
  private completionContext: CompletionContext | null = null;
  private completions: FormulaCompletion[] = [];
  private completionIndex = 0;

  constructor(
    element: HTMLFormElement,
    private readonly callbacks: FormulaBarCallbacks,
  ) {
    this.input = required(element, ".formula-input");
    this.error = required(element, ".formula-error");
    this.errorGuidance = required(element, ".formula-error-guidance");
    this.helpButton = required(element, ".formula-help-button");
    this.helpPopover = required(element, ".formula-help-popover");
    this.helpExample = required(element, ".formula-help-example");
    this.completionList = required(element, ".formula-completions");
    element.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.submit();
    });
    this.input.addEventListener("keydown", (event) => {
      this.onKeyDown(event);
    });
    this.input.addEventListener("input", () => {
      this.refreshCompletions(false);
    });
    this.helpButton.addEventListener("click", () => {
      this.toggleHelp();
    });
    this.helpButton.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.onKeyDown(event);
    });
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
  }

  setOpen(open: boolean): void {
    if (open) {
      if (!helpWasSeen()) this.openHelp();
      this.input.focus();
    } else {
      this.clearCompletions();
      this.closeHelp();
      this.input.blur();
    }
  }

  setSignals(paths: readonly string[]): void {
    this.signals = [...paths];
    this.renderHelpExample();
  }

  private onKeyDown(event: KeyboardEvent): void {
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
    if (event.key === "Escape") {
      event.preventDefault();
      if (!this.helpPopover.hidden) {
        this.closeHelp();
        return;
      }
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
      this.errorGuidance.hidden = true;
      this.errorGuidance.textContent = "";
    } catch (failure: unknown) {
      this.derivedCounter -= 1;
      this.error.textContent =
        failure instanceof Error ? failure.message : String(failure);
      this.error.hidden = false;
      this.errorGuidance.textContent = ERROR_GUIDANCE;
      this.errorGuidance.hidden = false;
    }
  }

  private toggleHelp(): void {
    if (this.helpPopover.hidden) this.openHelp();
    else this.closeHelp();
  }

  private openHelp(): void {
    this.clearCompletions();
    this.helpPopover.hidden = false;
    this.helpButton.setAttribute("aria-expanded", "true");
  }

  private closeHelp(): void {
    this.helpPopover.hidden = true;
    this.helpButton.setAttribute("aria-expanded", "false");
    rememberHelp();
  }

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

  private renderCompletions(): void {
    const options = this.completions.map((completion, index) => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "formula-completion";
      option.id = `formula-completion-${String(index)}`;
      option.tabIndex = -1;
      option.setAttribute("role", "option");
      option.setAttribute(
        "aria-selected",
        String(index === this.completionIndex),
      );

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
      return option;
    });
    this.completionList.replaceChildren(...options);
    this.completionList.hidden = false;
    this.input.setAttribute("aria-expanded", "true");
    this.input.setAttribute(
      "aria-activedescendant",
      `formula-completion-${String(this.completionIndex)}`,
    );
  }

  private clearCompletions(): void {
    this.completionContext = null;
    this.completions = [];
    this.completionIndex = 0;
    this.completionList.replaceChildren();
    this.completionList.hidden = true;
    this.input.setAttribute("aria-expanded", "false");
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

  private renderHelpExample(): void {
    const first = this.signals[0];
    this.helpExample.textContent =
      first === undefined
        ? "Load a source, then drag signals here."
        : `derived/result = ${quoteSignalPath(first)}`;
  }
}

function clampIndex(index: number, length: number): number {
  return Math.min(Math.max(index, 0), length);
}

export function formulaBarMarkup(): string {
  return `<form class="formula-bar" id="formula-editor">
    <span class="formula-mark">ƒx</span>
    <input class="formula-input" role="combobox" aria-label="Derived signal formula" aria-autocomplete="list" aria-controls="formula-completions" aria-expanded="false" placeholder="derived/name = expression · drop signals here" spellcheck="false" />
    <span class="formula-error" role="alert" hidden></span>
    <span class="formula-error-guidance" hidden>Signal references use quoted full paths. Drag from the tree to insert.</span>
    <button type="button" class="formula-help-button" aria-label="Formula help" aria-controls="formula-help" aria-expanded="false">?</button>
    <div class="formula-help-popover" id="formula-help" role="dialog" aria-label="Derived formula help" hidden>
      <strong>Derived formulas</strong>
      <code>derived/name = expression</code>
      <span>Signals use quoted full paths. Drag from the tree to insert.</span>
      <code class="formula-help-example"></code>
      <code>gradient(x) · cumtrapz(x) · movmean(x, 51)</code>
      <code>abs(x) · hypot(x, y)</code>
      <span>↵ create · ↑/↓ history · esc close · ctrl+space complete</span>
    </div>
    <div class="formula-completions" id="formula-completions" role="listbox" aria-label="Formula suggestions" hidden></div>
  </form>`;
}
