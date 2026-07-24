import {
  PROTOCOL_VERSION,
  type SignalSummary,
  type TileResponse,
} from "../generated/protocol";
import type { DataPlane } from "../app/data-plane";
import { LinkedTimeModel } from "../app/linked-time";
import { CanvasRenderer, SERIES_TOKENS } from "../render/canvas-renderer";

const MODE_LABELS = ["T", "XY", "FFT", "H"] as const;
export class AppShell {
  private readonly time = new LinkedTimeModel();
  private signals: SignalSummary[] = [];
  private selectedIds: string[] = [];
  private renderer: CanvasRenderer | null = null;
  private latestTiles: TileResponse | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly plane: DataPlane,
  ) {}

  async mount(): Promise<void> {
    this.root.innerHTML = shellMarkup(this.plane.host);
    this.bindControls();
    const canvas = this.requireElement<HTMLCanvasElement>(".plot-canvas");
    this.renderer = new CanvasRenderer(canvas);

    this.signals = await this.plane.listSignals();
    this.selectedIds = this.signals
      .slice(0, 3)
      .map((signal) => signal.signal_id);
    this.renderSignalTree();
    this.renderLegend();
    this.updateStatus();
    await this.refreshTiles();

    const observer = new ResizeObserver(() => this.renderCanvas());
    observer.observe(canvas);
  }

  private bindControls(): void {
    this.requireElement(".theme-toggle").addEventListener("click", () =>
      this.toggleTheme(),
    );
    this.requireElement(".linked-toggle").addEventListener("click", (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      const linked = !this.time.snapshot().linked;
      this.time.setLinked(linked, "toolbar");
      button.classList.toggle("active", linked);
    });
    this.requireElement<HTMLInputElement>(".signal-search").addEventListener(
      "input",
      () => this.renderSignalTree(),
    );
    window.addEventListener("keydown", (event) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      if (event.key.toLowerCase() === "t") this.toggleTheme();
      if (event.key === "/") {
        event.preventDefault();
        this.requireElement<HTMLInputElement>(".signal-search").focus();
      }
    });
  }

  private async refreshTiles(): Promise<void> {
    const state = this.time.snapshot();
    this.latestTiles = await this.plane.queryTiles({
      protocol_version: PROTOCOL_VERSION,
      request_id: crypto.randomUUID(),
      signal_ids: this.selectedIds,
      window: { t0: state.t0, t1: state.t1 },
      pixel_width: Math.max(
        1,
        Math.round(
          this.requireElement<HTMLCanvasElement>(".plot-canvas").clientWidth,
        ),
      ),
    });
    this.renderCanvas();
  }

  private renderCanvas(): void {
    if (this.renderer === null || this.latestTiles === null) return;
    const state = this.time.snapshot();
    const elapsed = this.renderer.render(this.latestTiles, {
      min: state.t0,
      max: state.t1,
    });
    this.requireElement(".render-ms").textContent = `${elapsed.toFixed(1)} ms`;
  }

  private renderSignalTree(): void {
    const filter = this.requireElement<HTMLInputElement>(".signal-search")
      .value.toLowerCase()
      .trim();
    const list = this.requireElement(".tree-list");
    const visible = this.signals.filter((signal) =>
      signal.path.toLowerCase().includes(filter),
    );
    if (visible.length === 0) {
      const empty = document.createElement("div");
      empty.className = "signal-row";
      empty.textContent = "No matching signals.";
      list.replaceChildren(empty);
    } else {
      list.replaceChildren(
        ...visible.map((signal, index) => {
          const selected = this.selectedIds.includes(signal.signal_id);
          const row = document.createElement("button");
          row.className = `signal-row ${selected ? "selected" : ""}`;
          row.dataset.signalId = signal.signal_id;
          const mark = document.createElement("span");
          mark.className = "series-mark";
          mark.style.background = `var(${SERIES_TOKENS[index % SERIES_TOKENS.length] ?? "--series-1"})`;
          const path = document.createElement("span");
          path.className = "signal-path";
          path.textContent = signal.path;
          const value = document.createElement("span");
          value.className = "signal-value";
          value.textContent = "—";
          row.append(mark, path, value);
          return row;
        }),
      );
    }

    for (const row of list.querySelectorAll<HTMLButtonElement>(
      "[data-signal-id]",
    )) {
      row.addEventListener("dblclick", () => {
        const id = row.dataset.signalId;
        if (id === undefined) return;
        this.selectedIds = this.selectedIds.includes(id)
          ? this.selectedIds.filter((selected) => selected !== id)
          : [...this.selectedIds, id];
        this.renderSignalTree();
        this.renderLegend();
        void this.refreshTiles().catch((error: unknown) => this.reportError(error));
      });
    }
  }

  private renderLegend(): void {
    const legend = this.requireElement(".panel-legend");
    const selected = this.signals.filter((signal) =>
      this.selectedIds.includes(signal.signal_id),
    );
    legend.replaceChildren(
      ...selected.map((signal, index) => {
        const chip = document.createElement("button");
        chip.className = "legend-chip";
        chip.title = signal.path;
        const line = document.createElement("span");
        line.className = "legend-line";
        line.style.background = `var(${SERIES_TOKENS[index % SERIES_TOKENS.length] ?? "--series-1"})`;
        const name = document.createElement("span");
        name.className = "legend-name";
        name.textContent = shortName(signal.path);
        const menu = document.createElement("span");
        menu.className = "legend-menu";
        menu.textContent = "▾";
        chip.append(line, name, menu);
        return chip;
      }),
    );
  }

  private updateStatus(): void {
    const pointCount = this.signals.reduce(
      (total, signal) => total + Number(signal.point_count),
      0,
    );
    this.requireElement(".signal-count").textContent =
      `${this.signals.length.toLocaleString()} signals`;
    this.requireElement(".point-count").textContent =
      `${pointCount.toLocaleString()} pts`;
    this.requireElement(".source-points").textContent =
      `${pointCount.toLocaleString()} pts`;
  }

  private toggleTheme(): void {
    const root = document.documentElement;
    root.dataset.theme = root.dataset.theme === "light" ? "dark" : "light";
    this.renderCanvas();
  }

  private reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.requireElement(".render-ms").textContent = `error: ${message}`;
    console.error(error);
  }

  private requireElement<T extends Element = HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (element === null) {
      throw new Error(`Missing application element: ${selector}`);
    }
    return element;
  }
}

function shellMarkup(host: DataPlane["host"]): string {
  return `<main class="workbench">
    <nav class="menu-bar" aria-label="Application menu">
      <span class="brand">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 11 4 5l3 8 3-10 2 6 2-2" fill="none" stroke="var(--amber-7)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        SIGNALSCOPE
      </span>
      ${["File", "Edit", "View", "Panel", "Signals", "Export", "Help"]
        .map((item) => `<button class="menu-item">${item}</button>`)
        .join("")}
      <span class="command-hint">commands <kbd>⌘K</kbd></span>
    </nav>

    <div class="tool-bar">
      <button class="tool-button">Open Files</button>
      <button class="tool-button">Demo Data</button>
      <span class="tool-divider"></span>
      <button class="tool-button">+ Panel</button>
      <button class="tool-button">Layout <span class="status-value">walking skeleton</span> ▾</button>
      <span class="tool-divider"></span>
      <button class="tool-button active linked-toggle">⇄ Linked t</button>
      <button class="tool-button">Σ Stats</button>
      <button class="tool-button">ƒx Derived</button>
      <span class="tool-spacer"></span>
      <button class="tool-button theme-toggle" title="Toggle theme (T)">◐</button>
      <span class="window-label">window</span>
      <span class="window-readout">t: 0.000 → 60.000 s</span>
      <button class="tool-button follow-slot" disabled>⏸ FOLLOW</button>
    </div>

    <aside class="signal-tree" aria-label="Signals">
      <div class="search-wrap">
        <label>/ <input class="signal-search" placeholder="filter signals…" spellcheck="false" /></label>
      </div>
      <div class="tree-heading">★ FAVORITES</div>
      <div class="tree-heading">SIGNALS</div>
      <div class="tree-list"></div>
      <div class="source-footer">
        <div class="source-row">
          <span class="status-dot"></span>
          <span>${host === "native" ? "native data plane" : "baked demo source"}</span>
          <span class="source-points">0 pts</span>
        </div>
      </div>
    </aside>

    <section class="workspace" aria-label="Panel workspace">
      <article class="panel" aria-label="Body velocity panel">
        <header class="panel-header">
          <span class="drag-handle" aria-hidden="true">⠿</span>
          <span class="panel-title">Body velocity</span>
          <span class="mode-pills" aria-label="Panel mode">
            ${MODE_LABELS.map(
              (label, index) =>
                `<button class="mode-pill ${index === 0 ? "active" : ""}">${label}</button>`,
            ).join("")}
          </span>
          <span class="panel-legend"></span>
          <span class="panel-actions">
            <button class="panel-action" title="Split panel">⊞</button>
            <button class="panel-action" title="Maximize panel">⤢</button>
            <button class="panel-action" title="Close panel">✕</button>
          </span>
        </header>
        <div class="plot-wrap">
          <canvas class="plot-canvas" aria-label="Time-series plot"></canvas>
        </div>
      </article>
    </section>

    <form class="formula-bar">
      <span class="formula-mark">ƒx</span>
      <input class="formula-input" aria-label="Derived signal formula" placeholder='derived/name = Math.hypot($("signal/x"), $("signal/y"))' spellcheck="false" />
    </form>

    <footer class="status-bar">
      <span><span class="status-dot"></span> <span class="signal-count">0 signals</span></span>
      <span class="point-count status-value">0 pts</span>
      <span>render <span class="render-ms status-value">— ms</span></span>
      <span>cursor <span class="status-value">t = —</span></span>
      <span class="gesture-hint">drag = box zoom · wheel = zoom t · ⇧wheel = zoom y · right-drag = pan · dbl-click = fit · click = datatip</span>
      <span class="status-command">⌘K</span>
    </footer>
  </main>`;
}

function shortName(path: string): string {
  return path.split("/").slice(-2).join("/");
}
