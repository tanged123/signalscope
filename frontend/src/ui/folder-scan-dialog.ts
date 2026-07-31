import type { ScanSourcesResponse } from "../generated/protocol";
import { basename, formatBytes, required } from "./dom";

export class FolderScanDialog {
  private readonly element: HTMLElement;
  private readonly recursive: HTMLInputElement;
  private readonly details: HTMLElement;
  private readonly load: HTMLButtonElement;
  private readonly title: HTMLElement;
  private readonly formats: HTMLElement;
  private files: string[] = [];
  private scan: ((recursive: boolean) => Promise<ScanSourcesResponse>) | null =
    null;
  private onLoad: ((files: string[]) => void) | null = null;
  private token = 0;
  private returnFocus: HTMLElement | null = null;
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || this.element.hidden) return;
    event.preventDefault();
    this.close();
  };

  constructor(root: HTMLElement) {
    this.element = document.createElement("div");
    this.element.className = "folder-scan-overlay";
    this.element.hidden = true;
    this.element.innerHTML = `<div class="folder-scan-dialog" role="dialog" aria-modal="true">
      <header class="folder-scan-title"></header>
      <div class="folder-scan-details"></div>
      <div class="folder-scan-formats"></div>
      <label class="folder-scan-recursive"><input type="checkbox" checked /> Include subfolders</label>
      <footer class="folder-scan-actions"><button type="button" class="folder-scan-cancel">Cancel</button><button type="button" class="folder-scan-load">Load</button></footer>
    </div>`;
    root.append(this.element);
    this.title = required(this.element, ".folder-scan-title");
    this.details = required(this.element, ".folder-scan-details");
    this.formats = required(this.element, ".folder-scan-formats");
    this.recursive = required(this.element, 'input[type="checkbox"]');
    this.load = required(this.element, ".folder-scan-load");
    this.recursive.addEventListener("change", () => this.rescan());
    this.load.addEventListener("click", () => {
      this.onLoad?.(this.files);
      this.close();
    });
    required(this.element, ".folder-scan-cancel").addEventListener(
      "click",
      () => {
        this.close();
      },
    );
    this.element.addEventListener("pointerdown", (event) => {
      if (event.target === this.element) this.close();
    });
  }

  open(
    folder: string,
    scan: (recursive: boolean) => Promise<ScanSourcesResponse>,
    onLoad: (files: string[]) => void,
  ): void {
    this.returnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    this.scan = scan;
    this.onLoad = onLoad;
    this.files = [];
    this.recursive.checked = true;
    this.title.textContent = basename(folder);
    this.title.title = folder;
    this.element.hidden = false;
    document.addEventListener("keydown", this.onKeyDown);
    this.rescan();
  }

  close(): void {
    this.token += 1;
    this.element.hidden = true;
    document.removeEventListener("keydown", this.onKeyDown);
    this.returnFocus?.focus();
    this.returnFocus = null;
  }

  private rescan(): void {
    const scan = this.scan;
    if (scan === null) return;
    const token = ++this.token;
    this.load.disabled = true;
    this.details.textContent = "Scanning…";
    this.formats.textContent = "";
    void scan(this.recursive.checked).then(
      (result) => {
        if (token !== this.token || this.element.hidden) return;
        this.files = result.files;
        const count = result.files.length;
        this.details.textContent =
          count === 0
            ? "No loadable files found."
            : `${count.toLocaleString()} loadable file${count === 1 ? "" : "s"} · ${formatBytes(Number(result.total_bytes))}`;
        this.formats.textContent = result.format_counts
          .map(
            ({ label, count: formatCount }) =>
              `${label}: ${formatCount.toLocaleString()}`,
          )
          .join(" · ");
        this.load.disabled = count === 0;
      },
      () => {
        if (token !== this.token || this.element.hidden) return;
        this.files = [];
        this.details.textContent = "Scan failed.";
      },
    );
  }
}
