import { fuzzyScore } from "../app/fuzzy";
import { required } from "./dom";

export interface PaletteEntry {
  title: string;
  hint: string;
  run: () => void;
  /** Set when the entry is listed but not runnable; the text says why. */
  unavailable?: string;
  /** Runs without closing the palette; the entry list refreshes after. */
  keepOpen?: boolean;
  /** ArrowLeft/ArrowRight handler for value entries (e.g. font sizes). */
  adjust?: (direction: -1 | 1) => void;
}

export type PaletteMode = "commands" | "signals" | "settings";

export class CommandPalette {
  private readonly element: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly list: HTMLElement;
  private entries: PaletteEntry[] = [];
  private matches: PaletteEntry[] = [];
  private selected = 0;
  private mode: PaletteMode = "commands";

  constructor(
    root: HTMLElement,
    private readonly provider: (mode: PaletteMode) => PaletteEntry[],
  ) {
    this.element = document.createElement("div");
    this.element.className = "palette-overlay";
    this.element.hidden = true;
    this.element.innerHTML = `<div class="palette">
        <input class="palette-input" placeholder="commands, signals…" spellcheck="false" aria-label="Command palette" />
        <div class="palette-list"></div>
      </div>`;
    root.appendChild(this.element);
    this.input = required<HTMLInputElement>(this.element, ".palette-input");
    this.list = required<HTMLElement>(this.element, ".palette-list");
    this.element.addEventListener("pointerdown", (event) => {
      if (event.target === this.element) this.close();
    });
    this.input.addEventListener("input", () => {
      this.filter();
    });
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        this.selected = Math.min(this.selected + 1, this.matches.length - 1);
        this.renderList();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        this.selected = Math.max(this.selected - 1, 0);
        this.renderList();
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const entry = this.matches[this.selected];
        if (entry?.adjust !== undefined) {
          event.preventDefault();
          entry.adjust(event.key === "ArrowRight" ? 1 : -1);
          this.refreshEntries();
        }
      } else if (event.key === "Enter") {
        event.preventDefault();
        this.runSelected();
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.close();
      }
    });
  }

  open(mode: PaletteMode): void {
    this.mode = mode;
    this.entries = this.provider(mode);
    this.element.hidden = false;
    this.input.placeholder =
      mode === "signals"
        ? "signals, workspaces, panels…"
        : mode === "settings"
          ? "settings — enter cycles, ←/→ adjust…"
          : "commands…";
    this.input.value = "";
    this.filter();
    this.input.focus();
  }

  close(): void {
    this.element.hidden = true;
  }

  isOpen(): boolean {
    return !this.element.hidden;
  }

  private filter(): void {
    const query = this.input.value;
    this.matches = this.entries
      .map((entry) => ({ entry, score: fuzzyScore(query, entry.title) }))
      .filter(
        (item): item is { entry: PaletteEntry; score: number } =>
          item.score !== null,
      )
      .sort((left, right) => right.score - left.score)
      .slice(0, 12)
      .map((item) => item.entry);
    this.selected = 0;
    this.renderList();
  }

  private renderList(): void {
    this.list.replaceChildren(
      ...this.matches.map((entry, index) => {
        const row = document.createElement("button");
        row.className = `palette-row ${index === this.selected ? "selected" : ""}`;
        if (entry.unavailable !== undefined) {
          row.disabled = true;
          row.title = entry.unavailable;
        }
        const title = document.createElement("span");
        title.textContent = entry.title;
        const hint = document.createElement("span");
        hint.className = "palette-hint";
        hint.textContent = entry.hint;
        row.append(title, hint);
        row.addEventListener("click", () => {
          if (entry.keepOpen === true) {
            entry.run();
            this.refreshEntries();
          } else {
            this.close();
            entry.run();
          }
        });
        return row;
      }),
    );
  }

  private runSelected(): void {
    const entry = this.matches[this.selected];
    if (entry === undefined || entry.unavailable !== undefined) return;
    if (entry.keepOpen === true) {
      entry.run();
      this.refreshEntries();
    } else {
      this.close();
      entry.run();
    }
  }

  /** Re-pulls entries so hints show updated values, keeping the selection. */
  private refreshEntries(): void {
    const selected = this.selected;
    this.entries = this.provider(this.mode);
    this.filter();
    this.selected = Math.min(selected, Math.max(0, this.matches.length - 1));
    this.renderList();
  }
}
