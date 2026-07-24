import { CommandRegistry } from "../app/commands";
import type { DataPlane } from "../app/data-plane";
import { runIngest } from "../app/ingest";
import { LinkedTimeModel } from "../app/linked-time";
import { WorkspaceModel } from "../app/workspace";
import { type SignalSummary, type TileResponse } from "../generated/protocol";
import { CommandPalette, type PaletteEntry } from "./command-palette";
import { required } from "./dom";
import { SignalTreeView } from "./signal-tree";
import { WorkspaceView } from "./workspace-view";

export class AppShell {
  private readonly time = new LinkedTimeModel();
  private readonly workspace = new WorkspaceModel();
  private readonly commands = new CommandRegistry();
  private signals: SignalSummary[] = [];
  private signalsByPath = new Map<string, SignalSummary>();
  private workspaceView: WorkspaceView | null = null;
  private tree: SignalTreeView | null = null;
  private palette: CommandPalette | null = null;
  private tilesByPanel = new Map<string, TileResponse>();

  constructor(
    private readonly root: HTMLElement,
    private readonly plane: DataPlane,
  ) {}

  async mount(): Promise<void> {
    this.root.innerHTML = shellMarkup();
    this.workspaceView = new WorkspaceView(
      required(this.root, ".workspace"),
      this.workspace,
      {
        onFocus: (id) => {
          if (this.workspace.focusedPanelId() !== id) {
            this.workspace.focusPanel(id);
            this.workspaceView?.refreshPanelStates();
          }
        },
        onClose: (id) => {
          this.workspace.closePanel(id);
          this.afterLayoutChange();
        },
        onSplit: (id) => {
          this.workspace.splitPanel(id);
          this.afterLayoutChange();
        },
        onMaximize: (id) => {
          this.workspace.toggleMaximize(id);
          this.afterLayoutChange();
        },
        onSelectMode: (id, mode) => {
          this.workspace.setMode(id, mode);
          this.workspaceView?.refreshPanelStates();
          void this.refreshTiles();
        },
        onDropSignal: (id, path) => {
          this.plotSignal(path, id);
        },
        onToggleSeries: (id, path) => {
          this.workspace.toggleSeriesVisible(id, path);
          this.workspaceView?.refreshPanelStates();
          this.renderTiles();
        },
        onResized: () => {
          this.renderTiles();
        },
        onLayoutChanged: () => {
          void this.refreshTiles();
        },
        onDropSignalNewPanel: (path) => {
          const panel = this.workspace.addPanelRow();
          this.plotSignal(path, panel.id);
        },
        onMovePanel: (id, rowIndex, cellIndex) => {
          this.workspace.movePanel(id, rowIndex, cellIndex);
          this.afterLayoutChange();
        },
      },
    );
    this.tree = new SignalTreeView(
      required(this.root, ".tree-scroll"),
      required(this.root, ".tree-favorites"),
      {
        onPlotSignal: (path) => {
          this.plotSignal(path);
        },
        onToggleFavorite: (path) => {
          this.workspace.toggleFavorite(path);
          this.tree?.setFavorites(this.workspace.favorites());
        },
      },
    );
    this.palette = new CommandPalette(this.root, () => this.paletteEntries());
    this.registerCommands();
    this.bindControls();
    await this.reloadSignals();
    if (this.signals.length > 0 && this.workspace.panels().length === 0) {
      const panel = this.workspace.addPanelRow();
      for (const summary of this.signals.slice(0, 2)) {
        this.workspace.addSeries(panel.id, summary.path);
      }
      this.fitWindowToPlotted();
    }
    this.afterLayoutChange();
  }

  private registerCommands(): void {
    this.commands.register({
      id: "open-files",
      title: "Open files…",
      keys: "o",
      enabled: () => this.plane.ingest !== null,
      run: () => {
        void this.openFiles();
      },
    });
    this.commands.register({
      id: "new-panel-row",
      title: "New panel row",
      keys: "n",
      run: () => {
        this.workspace.addPanelRow();
        this.afterLayoutChange();
      },
    });
    this.commands.register({
      id: "close-panel",
      title: "Close focused panel",
      enabled: () => this.workspace.focusedPanelId() !== null,
      run: () => {
        const id = this.workspace.focusedPanelId();
        if (id !== null) {
          this.workspace.closePanel(id);
          this.afterLayoutChange();
        }
      },
    });
    this.commands.register({
      id: "maximize-panel",
      title: "Maximize focused panel",
      enabled: () => this.workspace.focusedPanelId() !== null,
      run: () => {
        const id = this.workspace.focusedPanelId();
        if (id !== null) {
          this.workspace.toggleMaximize(id);
          this.afterLayoutChange();
        }
      },
    });
    this.commands.register({
      id: "focus-filter",
      title: "Filter signals",
      keys: "/",
      run: () => {
        required<HTMLInputElement>(this.root, ".signal-search").focus();
      },
    });
    this.commands.register({
      id: "toggle-linked",
      title: "Toggle linked time",
      keys: "l",
      run: () => {
        this.toggleLinked();
      },
    });
    this.commands.register({
      id: "toggle-theme",
      title: "Toggle theme",
      keys: "t",
      run: () => {
        this.toggleTheme();
      },
    });
    this.commands.register({
      id: "toggle-formula",
      title: "Toggle formula bar",
      keys: "e",
      run: () => {
        required(this.root, ".workbench").classList.toggle("formula-collapsed");
      },
    });
    this.commands.register({
      id: "command-palette",
      title: "Command palette",
      keys: "mod+k",
      run: () => {
        this.palette?.open();
      },
    });
    this.commands.register({
      id: "help",
      title: "Keyboard help",
      keys: "?",
      run: () => {
        this.palette?.open();
      },
    });
  }

  private paletteEntries(): PaletteEntry[] {
    const commands = this.commands.list().map((command) => ({
      title: command.title,
      hint: command.keys === undefined ? "" : keyHint(command.keys),
      run: () => {
        this.commands.run(command.id);
      },
    }));
    const signals = this.signals.map((summary) => ({
      title: `plot ${summary.path}`,
      hint: "signal",
      run: () => {
        this.plotSignal(summary.path);
      },
    }));
    return [...commands, ...signals];
  }

  private bindControls(): void {
    const openButton = required<HTMLButtonElement>(this.root, ".open-files");
    openButton.hidden = this.plane.ingest === null;
    openButton.addEventListener("click", () => {
      this.commands.run("open-files");
    });
    required(this.root, ".theme-toggle").addEventListener("click", () => {
      this.toggleTheme();
    });
    required(this.root, ".linked-toggle").addEventListener("click", () => {
      this.toggleLinked();
    });
    required(this.root, ".new-panel").addEventListener("click", () => {
      this.commands.run("new-panel-row");
    });
    required<HTMLInputElement>(this.root, ".signal-search").addEventListener(
      "input",
      (event) => {
        this.tree?.setFilter((event.target as HTMLInputElement).value);
      },
    );
    window.addEventListener("keydown", (event) => {
      if (this.palette?.isOpen() === true) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      if (this.commands.handleKey(event)) event.preventDefault();
    });
  }

  private plotSignal(path: string, panelId?: string): void {
    let target = panelId ?? this.workspace.focusedPanelId();
    if (target === null) {
      target = this.workspace.addPanelRow().id;
    }
    if (this.workspace.addSeries(target, path)) {
      this.workspace.focusPanel(target);
      this.fitWindowToPlotted();
      this.afterLayoutChange();
    }
  }

  private async openFiles(): Promise<void> {
    const port = this.plane.ingest;
    if (port === null) return;
    const progress = required<HTMLElement>(this.root, ".ingest-progress");
    try {
      const paths = await port.pickSources();
      for (const path of paths) {
        const name = path.split(/[\\/]/).at(-1) ?? path;
        progress.hidden = false;
        await runIngest(port, path, (status) => {
          const percent =
            status.fraction > 0 ? `${String(Math.round(status.fraction * 100))}%` : "…";
          progress.textContent = `${name} · ${status.stage} ${percent}`;
        });
      }
      await this.reloadSignals();
      this.afterLayoutChange();
    } catch (error: unknown) {
      this.reportError(error);
    } finally {
      progress.hidden = true;
    }
  }

  private fitWindowToPlotted(): void {
    let t0 = Number.POSITIVE_INFINITY;
    let t1 = Number.NEGATIVE_INFINITY;
    for (const panel of this.workspace.panels()) {
      for (const series of panel.series) {
        const summary = this.signalsByPath.get(series.path);
        if (summary !== undefined) {
          t0 = Math.min(t0, summary.t_min);
          t1 = Math.max(t1, summary.t_max);
        }
      }
    }
    if (Number.isFinite(t0) && Number.isFinite(t1)) {
      this.time.setWindow(t0, t1 > t0 ? t1 : t0 + 1);
      const state = this.time.snapshot();
      required(this.root, ".window-readout").textContent =
        `t: ${state.t0.toFixed(3)} → ${state.t1.toFixed(3)} s`;
    }
  }

  private afterLayoutChange(): void {
    this.workspaceView?.sync(this.signals.length > 0);
    void this.refreshTiles();
  }

  private async reloadSignals(): Promise<void> {
    this.signals = await this.plane.listSignals();
    this.signalsByPath = new Map(
      this.signals.map((summary) => [summary.path, summary]),
    );
    this.tree?.setSignals(this.signals.map((summary) => summary.path));
    this.tree?.setFavorites(this.workspace.favorites());
    this.updateStatus();
  }

  private async refreshTiles(): Promise<void> {
    const state = this.time.snapshot();
    const width = Math.max(
      1,
      Math.round(required(this.root, ".workspace").clientWidth),
    );
    const next = new Map<string, TileResponse>();
    await Promise.all(
      this.workspace.panels().map(async (panel) => {
        if (panel.mode !== "time") return;
        const ids = panel.series
          .map((series) => this.signalsByPath.get(series.path)?.signal_id)
          .filter((id): id is string => id !== undefined);
        if (ids.length === 0) return;
        try {
          next.set(
            panel.id,
            await this.plane.queryTiles({
              request_id: crypto.randomUUID(),
              signal_ids: ids,
              window: { t0: state.t0, t1: state.t1 },
              pixel_width: width,
            }),
          );
        } catch (error: unknown) {
          this.reportError(error);
        }
      }),
    );
    this.tilesByPanel = next;
    this.renderTiles();
  }

  private renderTiles(): void {
    const state = this.time.snapshot();
    const elapsed =
      this.workspaceView?.renderTiles(this.tilesByPanel, {
        t0: state.t0,
        t1: state.t1,
      }) ?? 0;
    required(this.root, ".render-ms").textContent = `${elapsed.toFixed(1)} ms`;
  }

  private updateStatus(): void {
    const pointCount = this.signals.reduce(
      (total, signal) => total + Number(signal.point_count),
      0,
    );
    required(this.root, ".signal-count").textContent =
      `${this.signals.length.toLocaleString()} signals`;
    required(this.root, ".point-count").textContent =
      `${pointCount.toLocaleString()} pts`;
    void this.updateSources();
  }

  private async updateSources(): Promise<void> {
    const sources = await this.plane.listSources();
    const rows = required(this.root, ".source-rows");
    rows.replaceChildren(
      ...sources.map((source) => {
        const row = document.createElement("div");
        row.className = "source-row";
        const dot = document.createElement("span");
        dot.className = "status-dot";
        const name = document.createElement("span");
        name.className = "signal-path";
        name.textContent = source.path.split(/[\\/]/).at(-1) ?? source.path;
        name.title = source.path;
        const points = document.createElement("span");
        points.className = "source-points";
        points.textContent =
          `${Number(source.point_count).toLocaleString()} pts`;
        row.append(dot, name, points);
        return row;
      }),
    );
  }

  private toggleLinked(): void {
    const linked = !this.time.snapshot().linked;
    this.time.setLinked(linked);
    required(this.root, ".linked-toggle").classList.toggle("active", linked);
  }

  private toggleTheme(): void {
    const documentRoot = document.documentElement;
    documentRoot.dataset.theme =
      documentRoot.dataset.theme === "light" ? "dark" : "light";
    this.workspaceView?.invalidateTheme();
    this.renderTiles();
  }

  private reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    required(this.root, ".render-ms").textContent = `error: ${message}`;
    console.error(error);
  }
}

function keyHint(keys: string): string {
  return keys === "mod+k" ? "⌘K" : keys.toUpperCase();
}

function shellMarkup(): string {
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
      <button class="tool-button open-files" hidden>Open Files</button>
      <button class="tool-button new-panel">+ Panel</button>
      <span class="tool-divider"></span>
      <button class="tool-button active linked-toggle">⇄ Linked t</button>
      <button class="tool-button theme-toggle" title="Toggle theme (T)">◐</button>
      <span class="tool-spacer"></span>
      <span class="window-label">window</span>
      <span class="window-readout">t: 0.000 → 60.000 s</span>
      <button class="tool-button follow-slot" disabled>⏸ FOLLOW</button>
    </div>

    <aside class="signal-tree" aria-label="Signals">
      <div class="search-wrap">
        <label>/ <input class="signal-search" placeholder="filter signals…" spellcheck="false" /></label>
      </div>
      <div class="tree-heading">★ FAVORITES</div>
      <div class="tree-favorites"></div>
      <div class="tree-heading">SIGNALS</div>
      <div class="tree-scroll"></div>
      <div class="source-footer">
        <div class="ingest-progress" hidden></div>
        <div class="source-rows"></div>
      </div>
    </aside>

    <section class="workspace" aria-label="Panel workspace"></section>

    <form class="formula-bar">
      <span class="formula-mark">ƒx</span>
      <input class="formula-input" aria-label="Derived signal formula" placeholder='derived/name = Math.hypot($("signal/x"), $("signal/y"))' spellcheck="false" />
    </form>

    <footer class="status-bar">
      <span><span class="status-dot"></span> <span class="signal-count">0 signals</span></span>
      <span class="point-count status-value">0 pts</span>
      <span>render <span class="render-ms status-value">— ms</span></span>
      <span>cursor <span class="status-value">t = —</span></span>
      <span class="gesture-hint">drag signal → panel · N = new row · / = filter · ⌘K = commands</span>
      <span class="status-command">⌘K</span>
    </footer>
  </main>`;
}
