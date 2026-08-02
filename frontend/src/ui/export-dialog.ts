import type {
  ExportEstimate,
  ExportEstimateEntry,
  ExportFidelity,
  ExportRange,
} from "../generated/protocol";
import { formatBytes, required } from "./dom";

export type ExportFormat = "html" | "png" | "csv";
export type PngScope = "focused" | "all";

export interface CsvEstimate {
  bytes: number;
  rows: number;
  stride: number;
}

export interface ExportDelegate {
  estimateHtml(setKeys: readonly string[]): Promise<ExportEstimate | null>;
  exportSets?(): { key: string; label: string }[];
  pngBytes(): Promise<number | null>;
  pngPanelCount(): number;
  csvEstimate(fidelity: ExportFidelity): Promise<CsvEstimate | null>;
  runExport(
    format: ExportFormat,
    range: ExportRange,
    fidelity: ExportFidelity,
    pngScope: PngScope,
    setKeys: readonly string[],
  ): Promise<void>;
}

const LARGE_EXPORT_BYTES = 100_000_000;
const FIDELITIES: ExportFidelity[] = ["preview", "standard", "high", "full"];

export class ExportDialog {
  private readonly element: HTMLElement;
  private readonly confirm: HTMLButtonElement;
  private selected: ExportFormat = "html";
  private range: ExportRange = "visible";
  private fidelity: ExportFidelity = "standard";
  private pngScope: PngScope = "focused";
  private htmlEstimate: ExportEstimate | null | undefined;
  private pngSize: number | null = null;
  private pngLoaded = false;
  private csv: CsvEstimate | null = null;
  private csvLoaded = false;
  private csvFidelity: ExportFidelity = "high";
  private loadToken = 0;
  private pngLoadToken = 0;
  private csvLoadToken = 0;
  private returnFocus: HTMLElement | null = null;
  private selectedSetKeys = new Set<string>();
  private readonly onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || this.element.hidden) return;
    event.preventDefault();
    event.stopPropagation();
    this.close();
  };

  constructor(
    root: HTMLElement,
    private readonly delegate: ExportDelegate,
  ) {
    this.element = document.createElement("div");
    this.element.className = "export-overlay";
    this.element.hidden = true;
    this.element.innerHTML = `<div class="export-dialog" role="dialog" aria-modal="true" aria-label="Export">
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
      <div class="export-controls">
        <div class="export-png-scope" hidden>
          <span class="export-control-title">PANELS</span>
          <div class="export-options" role="radiogroup" aria-label="PNG panels">
            <button class="export-option active" data-png-scope="focused" aria-pressed="true">focused panel</button>
            <button class="export-option" data-png-scope="all" aria-pressed="false">all panels</button>
          </div>
        </div>
        <div class="export-set-selection" hidden>
          <span class="export-control-title">SOURCES</span>
          <div class="export-set-options"></div>
        </div>
        <span class="export-control-title">RANGE</span>
        <div class="export-options export-range" role="radiogroup" aria-label="Export range">
          <button class="export-option active" data-range="visible" aria-pressed="true">visible window</button>
          <button class="export-option" data-range="all" aria-pressed="false">all loaded</button>
        </div>
        <span class="export-control-title">FIDELITY</span>
        <div class="export-options export-fidelity" role="radiogroup" aria-label="Export fidelity">
          <button class="export-option export-fidelity-option" data-fidelity="preview" aria-pressed="false">preview<span class="export-fidelity-size" data-fidelity-size="preview">…</span></button>
          <button class="export-option export-fidelity-option" data-fidelity="standard" aria-pressed="false">standard<span class="export-fidelity-size" data-fidelity-size="standard">…</span></button>
          <button class="export-option export-fidelity-option" data-fidelity="high" aria-pressed="false">high<span class="export-fidelity-size" data-fidelity-size="high">…</span></button>
          <button class="export-option export-fidelity-option" data-fidelity="full" aria-pressed="false">full<span class="export-fidelity-size" data-fidelity-size="full">…</span></button>
        </div>
        <p class="export-awareness">…</p>
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
    required(this.element, ".export-cancel").addEventListener("click", () => {
      this.close();
    });
    for (const input of this.element.querySelectorAll<HTMLInputElement>(
      'input[name="export-format"]',
    )) {
      input.addEventListener("change", () => {
        this.selected = input.value as ExportFormat;
        this.fidelity = this.selected === "csv" ? "high" : "standard";
        if (this.selected === "csv" && this.csvFidelity !== this.fidelity) {
          void this.loadCsv(this.fidelity);
        }
        this.renderSelection();
      });
    }
    for (const button of this.element.querySelectorAll<HTMLButtonElement>(
      "[data-range]",
    )) {
      button.addEventListener("click", () => {
        this.range = button.dataset.range as ExportRange;
        this.renderSelection();
      });
    }
    for (const button of this.element.querySelectorAll<HTMLButtonElement>(
      "[data-fidelity]",
    )) {
      button.addEventListener("click", () => {
        this.fidelity = button.dataset.fidelity as ExportFidelity;
        if (this.selected === "csv" && this.csvFidelity !== this.fidelity) {
          void this.loadCsv(this.fidelity);
        }
        this.renderSelection();
      });
    }
    for (const button of this.element.querySelectorAll<HTMLButtonElement>(
      "[data-png-scope]",
    )) {
      button.addEventListener("click", () => {
        this.pngScope = button.dataset.pngScope as PngScope;
        this.renderSelection();
      });
    }
    this.confirm.addEventListener("click", () => {
      void this.run();
    });
  }

  open(format: ExportFormat): void {
    if (this.element.hidden) {
      this.returnFocus =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    }
    this.selected = format;
    this.range = "visible";
    this.fidelity = format === "csv" ? "high" : "standard";
    this.pngScope = "focused";
    this.htmlEstimate = undefined;
    this.pngSize = null;
    this.pngLoaded = false;
    this.csv = null;
    this.csvLoaded = false;
    this.renderSetOptions();
    this.element.hidden = false;
    document.addEventListener("keydown", this.onDocumentKeyDown);
    this.renderSelection();
    void this.loadHtmlEstimate();
    const pngToken = ++this.pngLoadToken;
    void this.delegate.pngBytes().then((png) => {
      if (pngToken !== this.pngLoadToken || this.element.hidden) return;
      this.pngSize = png;
      this.pngLoaded = true;
      this.renderSelection();
    });
    void this.loadCsv("high");
    required<HTMLInputElement>(
      this.element,
      `input[value="${format}"]`,
    ).focus();
  }

  close(): void {
    this.element.hidden = true;
    this.loadToken += 1;
    this.pngLoadToken += 1;
    this.csvLoadToken += 1;
    document.removeEventListener("keydown", this.onDocumentKeyDown);
    this.returnFocus?.focus();
    this.returnFocus = null;
  }

  isOpen(): boolean {
    return !this.element.hidden;
  }

  private async loadCsv(fidelity: ExportFidelity): Promise<void> {
    this.csv = null;
    this.csvLoaded = false;
    this.csvFidelity = fidelity;
    this.renderSelection();
    const token = ++this.csvLoadToken;
    const csv = await this.delegate.csvEstimate(fidelity);
    if (token !== this.csvLoadToken || this.element.hidden) return;
    this.csv = csv;
    this.csvLoaded = true;
    this.renderSelection();
  }

  private async run(): Promise<void> {
    this.confirm.disabled = true;
    try {
      await this.delegate.runExport(
        this.selected,
        this.range,
        this.fidelity,
        this.pngScope,
        [...this.selectedSetKeys],
      );
      this.close();
    } catch {
      // The delegate reports the error; keep the dialog open for retry.
    } finally {
      this.confirm.disabled = false;
    }
  }

  private renderSetOptions(): void {
    const sets = this.delegate.exportSets?.() ?? [];
    this.selectedSetKeys = new Set(sets.map((set) => set.key));
    const container = required<HTMLElement>(
      this.element,
      ".export-set-selection",
    );
    container.hidden = sets.length === 0;
    const options = required<HTMLElement>(container, ".export-set-options");
    options.replaceChildren(
      ...sets.map((set) => {
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = true;
        input.addEventListener("change", () => {
          if (input.checked) this.selectedSetKeys.add(set.key);
          else this.selectedSetKeys.delete(set.key);
          void this.loadHtmlEstimate();
        });
        label.append(input, set.label);
        return label;
      }),
    );
  }

  private async loadHtmlEstimate(): Promise<void> {
    const token = ++this.loadToken;
    this.htmlEstimate = undefined;
    this.renderSelection();
    const estimate = await this.delegate.estimateHtml([
      ...this.selectedSetKeys,
    ]);
    if (token !== this.loadToken || this.element.hidden) return;
    this.htmlEstimate = estimate;
    this.renderSelection();
  }

  private entry(
    range = this.range,
    fidelity = this.fidelity,
  ): ExportEstimateEntry | undefined {
    return this.htmlEstimate?.entries.find(
      (entry) => entry.range === range && entry.fidelity === fidelity,
    );
  }

  private renderSelection(): void {
    for (const input of this.element.querySelectorAll<HTMLInputElement>(
      'input[name="export-format"]',
    )) {
      input.checked = input.value === this.selected;
      input.closest(".export-row")?.classList.toggle("selected", input.checked);
    }
    this.renderRows();

    const htmlSelected = this.selected === "html";
    const pngSelected = this.selected === "png";
    const fidelitySelected = htmlSelected || this.selected === "csv";
    const controls = required(this.element, ".export-controls");
    controls.classList.remove("disabled");
    required<HTMLElement>(this.element, ".export-png-scope").hidden =
      !pngSelected;
    required(this.element, ".export-range").classList.toggle(
      "disabled",
      !htmlSelected,
    );
    for (const button of this.element.querySelectorAll<HTMLButtonElement>(
      "[data-range]",
    )) {
      const active = button.dataset.range === this.range;
      button.disabled = !htmlSelected;
      button.classList.toggle("active", active);
      button.ariaPressed = String(active);
    }
    for (const button of this.element.querySelectorAll<HTMLButtonElement>(
      "[data-fidelity]",
    )) {
      const active = button.dataset.fidelity === this.fidelity;
      button.disabled = !fidelitySelected;
      button.classList.toggle("active", active);
      button.ariaPressed = String(active);
    }
    for (const button of this.element.querySelectorAll<HTMLButtonElement>(
      "[data-png-scope]",
    )) {
      const active = button.dataset.pngScope === this.pngScope;
      button.classList.toggle("active", active);
      button.ariaPressed = String(active);
    }
    this.renderFidelitySizes();
    this.renderAwareness();

    const bytes = this.selectedBytes();
    this.confirm.textContent =
      bytes !== null && bytes > LARGE_EXPORT_BYTES
        ? `Export ${formatBytes(bytes)}`
        : "Export";
    const selectedAvailable =
      this.selected === "html"
        ? this.entry() !== undefined
        : this.selected === "csv"
          ? this.csv !== null && this.csvFidelity === this.fidelity
          : this.pngScope === "all"
            ? this.delegate.pngPanelCount() > 0
            : this.pngSize !== null;
    this.confirm.disabled = !selectedAvailable;
  }

  private renderRows(): void {
    const htmlEntry = this.entry();
    this.setRow(
      "html",
      htmlEntry === undefined ? null : Number(htmlEntry.bytes),
      this.htmlEstimate === null
        ? "workbench only"
        : htmlEntry === undefined
          ? "…"
          : `~${formatBytes(Number(htmlEntry.bytes))}`,
    );
    this.setRow(
      "png",
      this.pngSize,
      this.pngScope === "all"
        ? `${formatCount(this.delegate.pngPanelCount())} PNG files`
        : this.pngSize === null
          ? this.pngLoaded
            ? "no focused panel"
            : "…"
          : formatBytes(this.pngSize),
    );
    const csv = this.csv;
    this.setRow(
      "csv",
      csv?.bytes ?? null,
      csv === null
        ? this.csvLoaded
          ? "no focused panel"
          : "…"
        : `${formatBytes(csv.bytes)} · ${formatCount(csv.rows)} rows · stride 1:${String(csv.stride)}`,
    );
  }

  private setRow(
    format: ExportFormat,
    bytes: number | null,
    label: string,
  ): void {
    const row = this.row(format);
    const unavailable =
      (format === "html" && this.htmlEstimate === null) ||
      (format === "png" &&
        this.pngLoaded &&
        bytes === null &&
        this.delegate.pngPanelCount() === 0) ||
      (format === "csv" && this.csvLoaded && bytes === null);
    required<HTMLInputElement>(row, "input").disabled = unavailable;
    row.classList.toggle("disabled", unavailable);
    required(row, `[data-size="${format}"]`).textContent = label;
  }

  private renderFidelitySizes(): void {
    for (const fidelity of FIDELITIES) {
      const size = required(this.element, `[data-fidelity-size="${fidelity}"]`);
      const entry = this.entry(this.range, fidelity);
      if (this.selected === "html") {
        size.textContent =
          entry === undefined ? "…" : `~${formatBytes(Number(entry.bytes))}`;
        size.classList.toggle(
          "warning",
          entry !== undefined && Number(entry.bytes) > LARGE_EXPORT_BYTES,
        );
      } else {
        size.textContent = "";
        size.classList.remove("warning");
      }
    }
  }

  private renderAwareness(): void {
    const awareness = required(this.element, ".export-awareness");
    const entry = this.entry();
    if (this.selected === "html" && entry !== undefined) {
      awareness.textContent = `${formatCount(entry.series_decimated)} of ${formatCount(entry.series_total)} series decimated · coarsest 1 pt per ${formatCount(entry.coarsest_ratio)} samples · ${formatCount(entry.series_full_rate)} kept at full rate`;
    } else if (
      this.selected === "csv" &&
      this.csv !== null &&
      this.csvFidelity === this.fidelity
    ) {
      awareness.textContent = `${formatCount(this.csv.rows)} rows · stride 1:${String(this.csv.stride)}`;
    } else if (this.selected === "png" && this.pngScope === "all") {
      awareness.textContent = `${formatCount(this.delegate.pngPanelCount())} panels across all workspaces`;
    } else {
      awareness.textContent = "…";
    }
  }

  private selectedBytes(): number | null {
    if (this.selected === "html") {
      const entry = this.entry();
      return entry === undefined ? null : Number(entry.bytes);
    }
    if (this.selected === "csv") {
      return this.csvFidelity === this.fidelity
        ? (this.csv?.bytes ?? null)
        : null;
    }
    if (this.pngScope === "all") return null;
    return this.pngSize;
  }

  private row(format: ExportFormat): HTMLElement {
    return required(this.element, `[data-format="${format}"]`);
  }
}

function formatCount(value: number | string): string {
  return BigInt(value).toLocaleString("en-US");
}
