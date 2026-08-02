import type { SelectionModel } from "../app/selection";

export interface BulkBarCallbacks {
  onAddToPanel(): void;
  onStyle(): void;
  onHide(): void;
  onSaveSet(): void;
  onDerive(): void;
  onMerge?(): void;
}

export class BulkBar {
  private deriveEnabled = true;
  private deriveTitle = "Derive from the selected signal(s)";
  private mergeEnabled = false;
  private mergeTitle = "Merge selected channels";
  private readonly unsubscribe: () => void;

  constructor(
    private readonly element: HTMLElement,
    private readonly selection: SelectionModel,
    private readonly callbacks: BulkBarCallbacks,
  ) {
    element.classList.add("bulk-bar");
    element.setAttribute("aria-live", "polite");
    this.unsubscribe = selection.onChange(() => this.render());
    this.render();
  }

  setDeriveEnabled(enabled: boolean, title: string): void {
    this.deriveEnabled = enabled;
    this.deriveTitle = title;
    this.render();
  }

  setMergeEnabled(enabled: boolean, title: string): void {
    this.mergeEnabled = enabled;
    this.mergeTitle = title;
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
    const actions = [
      ["add", "add to panel", () => this.callbacks.onAddToPanel()],
      ["style", "style…", () => this.callbacks.onStyle()],
      ["hide", "hide", () => this.callbacks.onHide()],
      ["save", "save as set", () => this.callbacks.onSaveSet()],
      ["derive", "derive ƒx", () => this.callbacks.onDerive()],
      ...(this.mergeEnabled
        ? ([
            ["merge", "merge channels", () => this.callbacks.onMerge?.()],
          ] as const)
        : []),
    ] as const;
    const actionRow = document.createElement("span");
    actionRow.className = "bulk-bar-actions";
    for (const action of actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "bulk-bar-link";
      button.dataset.action = action[0];
      button.textContent = action[1];
      button.addEventListener("click", action[2]);
      if (action[0] === "derive") {
        button.disabled = !this.deriveEnabled;
        button.title = this.deriveTitle;
      }
      if (action[0] === "merge") button.title = this.mergeTitle;
      actionRow.appendChild(button);
    }
    this.element.append(summary, actionRow);
    const hint = document.createElement("span");
    hint.className = "bulk-bar-hint";
    hint.textContent = "⇧click range · ⌘A all filtered";
    this.element.appendChild(hint);
  }
}
