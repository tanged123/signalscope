import { required } from "./dom";
import type { SourceOpenKind } from "../app/ingest";

export class SourceOpenDialog {
  private readonly element: HTMLElement;
  private returnFocus: HTMLElement | null = null;
  private onSelect: ((kind: SourceOpenKind) => void) | null = null;
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || this.element.hidden) return;
    event.preventDefault();
    event.stopPropagation();
    this.close();
  };

  constructor(root: HTMLElement) {
    this.element = document.createElement("div");
    this.element.className = "source-open-overlay";
    this.element.hidden = true;
    this.element.innerHTML = `<div class="source-open-dialog" role="dialog" aria-modal="true" aria-label="Open data">
      <header class="source-open-title">Open data</header>
      <div class="source-open-choices">
        <button type="button" class="source-open-files">Files</button>
        <button type="button" class="source-open-folder">Folder</button>
      </div>
      <button type="button" class="source-open-cancel">Cancel</button>
    </div>`;
    root.append(this.element);
    required(this.element, ".source-open-files").addEventListener("click", () =>
      this.select("files"),
    );
    required(this.element, ".source-open-folder").addEventListener(
      "click",
      () => this.select("folder"),
    );
    required(this.element, ".source-open-cancel").addEventListener(
      "click",
      () => this.close(),
    );
    this.element.addEventListener("pointerdown", (event) => {
      if (event.target === this.element) this.close();
    });
  }

  open(onSelect: (kind: SourceOpenKind) => void): void {
    this.returnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    this.onSelect = onSelect;
    this.element.hidden = false;
    document.addEventListener("keydown", this.onKeyDown);
    required<HTMLButtonElement>(this.element, ".source-open-files").focus();
  }

  close(): void {
    this.element.hidden = true;
    this.onSelect = null;
    document.removeEventListener("keydown", this.onKeyDown);
    this.returnFocus?.focus();
    this.returnFocus = null;
  }

  private select(kind: SourceOpenKind): void {
    const onSelect = this.onSelect;
    this.close();
    onSelect?.(kind);
  }
}
