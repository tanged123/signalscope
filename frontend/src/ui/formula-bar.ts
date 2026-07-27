import { parseFormulaInput, quoteSignalPath } from "../app/formula";
import { required } from "./dom";

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
  private signals: readonly string[] = [];
  private history: string[] = [];
  private historyIndex = 0;
  private derivedCounter = 0;

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
    element.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.submit();
    });
    this.input.addEventListener("keydown", (event) => {
      this.onKeyDown(event);
    });
    this.helpButton.addEventListener("click", () => {
      this.toggleHelp();
    });
    this.helpButton.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.onKeyDown(event);
    });
  }

  setOpen(open: boolean): void {
    if (open) {
      if (!helpWasSeen()) this.openHelp();
      this.input.focus();
    } else {
      this.closeHelp();
      this.input.blur();
    }
  }

  setSignals(paths: readonly string[]): void {
    this.signals = [...paths];
    this.renderHelpExample();
  }

  private onKeyDown(event: KeyboardEvent): void {
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
    this.helpPopover.hidden = false;
    this.helpButton.setAttribute("aria-expanded", "true");
  }

  private closeHelp(): void {
    this.helpPopover.hidden = true;
    this.helpButton.setAttribute("aria-expanded", "false");
    rememberHelp();
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
    <input class="formula-input" aria-label="Derived signal formula" placeholder="derived/name = expression · drop signals here" spellcheck="false" />
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
  </form>`;
}
