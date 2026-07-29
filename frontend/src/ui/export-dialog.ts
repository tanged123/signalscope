import { required } from "./dom";

export type ExportFormat = "html" | "png" | "csv";
type ExportScope = "visible" | "all";

export interface ExportDelegate {
  estimateHtml(): Promise<{
    visibleBytes: number;
    allBytes: number;
  } | null>;
  pngBytes(): Promise<number | null>;
  csvBytes(): Promise<number | null>;
  runExport(format: ExportFormat, scope: ExportScope): Promise<void>;
}

export class ExportDialog {
  private readonly element: HTMLElement;
  private readonly confirm: HTMLButtonElement;
  private selected: ExportFormat = "html";
  private scope: ExportScope = "visible";
  private loadToken = 0;

  constructor(
    root: HTMLElement,
    private readonly delegate: ExportDelegate,
  ) {
    this.element = document.createElement("div");
    this.element.className = "export-overlay";
    this.element.hidden = true;
    this.element.innerHTML = `<div class="export-dialog" role="dialog" aria-label="Export">
      <header class="export-title">Export</header>
      <label class="export-row" data-format="html">
        <input type="radio" name="export-format" value="html" />
        <span class="export-label">Standalone HTML snapshot</span>
        <span class="export-size" data-size="html">…</span>
      </label>
      <label class="export-row" data-format="png">
        <input type="radio" name="export-format" value="png" />
        <span class="export-label">PNG — focused panel</span>
        <span class="export-size" data-size="png">…</span>
      </label>
      <label class="export-row" data-format="csv">
        <input type="radio" name="export-format" value="csv" />
        <span class="export-label">CSV — visible region</span>
        <span class="export-size" data-size="csv">…</span>
      </label>
      <div class="export-scope">
        <span class="export-scope-title">EMBED DATA</span>
        <div class="export-scope-toggle" role="radiogroup" aria-label="Embedded data scope">
          <button class="export-scope-option active" data-scope="visible" aria-pressed="true">
            visible window · <span data-size="visible">…</span>
          </button>
          <button class="export-scope-option" data-scope="all" aria-pressed="false">
            all loaded · <span data-size="all">…</span>
          </button>
        </div>
        <p class="export-caption">decimated to ≤2k pts/series · annotations + zoom state included</p>
      </div>
      <footer class="export-actions">
        <button class="export-cancel">Cancel</button>
        <button class="export-confirm">Export</button>
      </footer>
    </div>`;
    root.appendChild(this.element);
    this.confirm = required(this.element, ".export-confirm");
    this.element.addEventListener("pointerdown", (event) => {
      if (event.target === this.element) this.close();
    });
    this.element.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.close();
      }
    });
    required(this.element, ".export-cancel").addEventListener("click", () => {
      this.close();
    });
    for (const input of this.element.querySelectorAll<HTMLInputElement>(
      'input[name="export-format"]',
    )) {
      input.addEventListener("change", () => {
        this.selected = input.value as ExportFormat;
        this.renderSelection();
      });
    }
    for (const button of this.element.querySelectorAll<HTMLButtonElement>(
      ".export-scope-option",
    )) {
      button.addEventListener("click", () => {
        this.scope = button.dataset.scope as ExportScope;
        this.renderSelection();
      });
    }
    this.confirm.addEventListener("click", () => {
      void this.run();
    });
  }

  open(format: ExportFormat): void {
    this.selected = format;
    this.scope = "visible";
    this.element.hidden = false;
    this.renderSelection();
    const token = ++this.loadToken;
    void Promise.all([
      this.delegate.estimateHtml(),
      this.delegate.pngBytes(),
      this.delegate.csvBytes(),
    ]).then(([html, png, csv]) => {
      if (token !== this.loadToken || this.element.hidden) return;
      this.setHtmlEstimate(html);
      this.setFormatEstimate("png", png);
      this.setFormatEstimate("csv", csv);
      this.renderSelection();
    });
    required<HTMLInputElement>(
      this.element,
      `input[value="${format}"]`,
    ).focus();
  }

  close(): void {
    this.element.hidden = true;
    this.loadToken += 1;
  }

  isOpen(): boolean {
    return !this.element.hidden;
  }

  private async run(): Promise<void> {
    this.confirm.disabled = true;
    try {
      await this.delegate.runExport(this.selected, this.scope);
      this.close();
    } catch {
      // The delegate reports the error; keep the dialog open for retry.
    } finally {
      this.confirm.disabled = false;
    }
  }

  private setHtmlEstimate(
    estimate: { visibleBytes: number; allBytes: number } | null,
  ): void {
    const row = this.row("html");
    const input = required<HTMLInputElement>(row, "input");
    input.disabled = estimate === null;
    row.classList.toggle("disabled", estimate === null);
    required(row, '[data-size="html"]').textContent =
      estimate === null
        ? "workbench only"
        : `~${formatBytes(estimate.visibleBytes)}`;
    required(this.element, '[data-size="visible"]').textContent =
      estimate === null ? "—" : `~${formatBytes(estimate.visibleBytes)}`;
    required(this.element, '[data-size="all"]').textContent =
      estimate === null ? "—" : `~${formatBytes(estimate.allBytes)}`;
  }

  private setFormatEstimate(format: "png" | "csv", bytes: number | null): void {
    const row = this.row(format);
    const input = required<HTMLInputElement>(row, "input");
    input.disabled = bytes === null;
    row.classList.toggle("disabled", bytes === null);
    required(row, `[data-size="${format}"]`).textContent =
      bytes === null ? "no focused panel" : formatBytes(bytes);
  }

  private renderSelection(): void {
    for (const input of this.element.querySelectorAll<HTMLInputElement>(
      'input[name="export-format"]',
    )) {
      input.checked = input.value === this.selected;
      input.closest(".export-row")?.classList.toggle("selected", input.checked);
    }
    const htmlSelected = this.selected === "html";
    required(this.element, ".export-scope").classList.toggle(
      "disabled",
      !htmlSelected,
    );
    for (const button of this.element.querySelectorAll<HTMLButtonElement>(
      ".export-scope-option",
    )) {
      const active = button.dataset.scope === this.scope;
      button.disabled = !htmlSelected;
      button.classList.toggle("active", active);
      button.ariaPressed = String(active);
    }
    this.confirm.disabled = required<HTMLInputElement>(
      this.row(this.selected),
      "input",
    ).disabled;
  }

  private row(format: ExportFormat): HTMLElement {
    return required(this.element, `[data-format="${format}"]`);
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000).toString()} kB`;
  return `${bytes.toString()} B`;
}
