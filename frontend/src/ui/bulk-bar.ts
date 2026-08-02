import type { SelectionModel } from "../app/selection";

export interface BulkBarCallbacks {
  onAddToPanel(): void;
  onStyle(): void;
  onHide(): void;
  onSaveSet(): void;
  onDerive(): void;
}

export class BulkBar {
  private deriveEnabled = true;
  private deriveTitle = "Derive from the selected signal(s)";
  private readonly unsubscribe: () => void;

  constructor(
    private readonly element: HTMLElement,
    private readonly selection: SelectionModel,
    private readonly callbacks: BulkBarCallbacks,
  ) {
    element.className = "bulk-bar";
    element.setAttribute("aria-live", "polite");
    this.unsubscribe = selection.onChange(() => this.render());
    this.render();
  }

  setDeriveEnabled(enabled: boolean, title: string): void {
    this.deriveEnabled = enabled;
    this.deriveTitle = title;
    this.render();
  }

  destroy(): void {
    this.unsubscribe();
  }

  private render(): void {
    const count = this.selection.size();
    this.element.hidden = count === 0;
    this.element.replaceChildren();
    if (count === 0) return;

    const summary = document.createElement("span");
    summary.className = "bulk-bar-count";
    summary.textContent = `${String(count)} selected`;
    this.element.appendChild(summary);
    for (const action of [
      ["add", "add to panel", () => this.callbacks.onAddToPanel()],
      ["style", "style…", () => this.callbacks.onStyle()],
      ["hide", "hide", () => this.callbacks.onHide()],
      ["save", "save as set", () => this.callbacks.onSaveSet()],
      ["derive", "derive ƒx", () => this.callbacks.onDerive()],
    ] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.action = action[0];
      button.textContent = action[1];
      button.addEventListener("click", action[2]);
      if (action[0] === "derive") {
        button.disabled = !this.deriveEnabled;
        button.title = this.deriveTitle;
      }
      this.element.appendChild(button);
    }
    const hint = document.createElement("span");
    hint.className = "bulk-bar-hint";
    hint.textContent = "⇧click range · ⌘A all filtered";
    this.element.appendChild(hint);
  }
}
