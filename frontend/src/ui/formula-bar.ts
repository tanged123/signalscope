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
    element: HTMLFormElement,
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

  setSignals(paths: readonly string[]): void {
    void paths;
  }

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
