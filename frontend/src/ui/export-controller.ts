import {
  buildCsv,
  buildHistogramCsv,
  csvMaxPoints,
  type CsvExport,
} from "../app/csv-export";
import type { DataPlane } from "../app/data-plane";
import { exportFileStem } from "../app/export-file";
import type { LineBindings } from "../app/line-bindings";
import { composePanelPng, panelPngTargets, toBase64 } from "../app/png-export";
import { snapshotPreferences } from "../app/preferences";
import type { WorkspaceModel } from "../app/workspace";
import type {
  ExportFidelity,
  ExportRange,
  ExportSelection,
  SampleSeries,
  SignalSummary,
} from "../generated/protocol";
import type { Preferences } from "../generated/preferences";
import type { PanelState } from "../generated/session";
import {
  ExportDialog,
  type ExportFormat,
  type PngScope,
} from "./export-dialog";

/** A panel's rendered canvases, as `WorkspaceView.capturePanel` returns them. */
interface PanelCapture {
  plot: HTMLCanvasElement;
  overlay: HTMLCanvasElement;
  windowNote?: string | null;
  quality?: string | null;
}

/** What exporting needs from the running shell. */
export interface ExportHost {
  readonly root: HTMLElement;
  readonly plane: DataPlane;
  readonly workspace: WorkspaceModel;
  signals(): readonly SignalSummary[];
  preferences(): Preferences;
  capturePanel(panelId: string): Promise<PanelCapture | null>;
  panelSignalIds(panel: PanelState): LineBindings;
  effectiveWindow(panel: PanelState): { t0: number; t1: number };
  /** Re-syncs the views to the workspace's active tab and redraws it. */
  presentWorkspace(): Promise<void>;
  reportError(error: unknown): void;
  notify(text: string): void;
}

/**
 * Owns the export dialog and writes HTML snapshots, panel PNGs and panel CSVs
 * through the data plane's exporter.
 */
export class ExportController {
  private dialog: ExportDialog | null = null;
  // The dialog's size estimate builds the file; exporting reuses it unless
  // the dialog was reopened since (the generation moved on).
  private png: Uint8Array | null = null;
  private readonly csv = new Map<ExportFidelity, CsvExport>();
  private generation = 0;

  constructor(private readonly host: ExportHost) {}

  isOpen(): boolean {
    return this.dialog?.isOpen() === true;
  }

  open(format: ExportFormat): void {
    this.generation += 1;
    this.png = null;
    this.csv.clear();
    this.dialog ??= new ExportDialog(this.host.root, {
      estimateHtml: async (setKeys) => {
        const exporter = this.host.plane.exporter;
        if (exporter === null) return null;
        try {
          return await exporter.estimate(
            JSON.stringify(this.host.workspace.snapshot()),
            this.selection(setKeys),
          );
        } catch (error: unknown) {
          this.host.reportError(error);
          return null;
        }
      },
      exportSets: () => exportSourceOptions(this.host.signals()),
      pngBytes: async () => {
        const generation = this.generation;
        try {
          const png = await this.focusedPng();
          if (generation === this.generation) this.png = png;
          return png?.length ?? null;
        } catch (error: unknown) {
          this.host.reportError(error);
          return null;
        }
      },
      pngPanelCount: () => panelPngTargets(this.host.workspace.tabs()).length,
      csvEstimate: async (fidelity) => {
        const generation = this.generation;
        try {
          const csv = await this.focusedCsv(fidelity);
          if (csv === null) return null;
          if (generation === this.generation) this.csv.set(fidelity, csv);
          return {
            bytes: new TextEncoder().encode(csv.text).length,
            rows: csv.rows,
            stride: csv.stride,
          };
        } catch (error: unknown) {
          this.host.reportError(error);
          return null;
        }
      },
      runExport: async (selected, range, fidelity, pngScope, setKeys) => {
        const cachedPng = this.png;
        const cachedCsv = this.csv.get(fidelity);
        this.generation += 1;
        try {
          await this.run(
            selected,
            range,
            fidelity,
            pngScope,
            cachedPng,
            cachedCsv,
            setKeys,
          );
        } catch (error: unknown) {
          this.host.reportError(error);
          throw error;
        }
      },
    });
    this.dialog.open(format);
  }

  private async run(
    format: ExportFormat,
    range: ExportRange,
    fidelity: ExportFidelity,
    pngScope: PngScope,
    cachedPng: Uint8Array | null,
    cachedCsv: CsvExport | undefined,
    setKeys: readonly string[],
  ): Promise<void> {
    const exporter = this.host.plane.exporter;
    if (exporter === null) return;
    const workspace = this.host.workspace;
    let path: string | null;
    if (format === "html") {
      path = await exporter.writeHtml(
        JSON.stringify(workspace.snapshot()),
        range,
        fidelity,
        this.selection(setKeys),
        snapshotPreferences(this.host.preferences()),
      );
    } else if (format === "png" && pngScope === "all") {
      path = await this.allPanelPngs();
    } else {
      const panelId = workspace.focusedPanelId();
      const panel = panelId === null ? undefined : workspace.panel(panelId);
      if (panel === undefined) return;
      const name = exportFileStem(panel.title, panel.id);
      if (format === "png") {
        const bytes = cachedPng ?? (await this.focusedPng());
        if (bytes === null) return;
        path = await exporter.saveFile(`${name}.png`, "png", toBase64(bytes));
      } else {
        const csv = cachedCsv ?? (await this.focusedCsv(fidelity));
        if (csv === null) return;
        path = await exporter.saveFile(
          `${name}.csv`,
          "csv",
          toBase64(new TextEncoder().encode(csv.text)),
        );
      }
    }
    if (path !== null) this.host.notify(`exported ${path}`);
  }

  private selection(sourceKeys?: readonly string[]): ExportSelection {
    const session = this.host.workspace.snapshot();
    return {
      source_keys: [
        ...(sourceKeys ?? session.sources.map((source) => source.key)),
      ],
    };
  }

  private async focusedPng(): Promise<Uint8Array | null> {
    const panelId = this.host.workspace.focusedPanelId();
    if (panelId === null) return null;
    return this.panelPng(panelId);
  }

  private async panelPng(panelId: string): Promise<Uint8Array | null> {
    const panel = this.host.workspace.panel(panelId);
    const canvases = await this.host.capturePanel(panelId);
    if (panel === undefined || canvases === null) return null;
    const styles = getComputedStyle(document.documentElement);
    const notes = [canvases.windowNote, canvases.quality].filter(
      (note): note is string => note !== null && note !== undefined,
    );
    const composed = composePanelPng(
      panel.title,
      canvases.plot,
      canvases.overlay,
      {
        background: styles.getPropertyValue("--surface-1").trim(),
        text: styles.getPropertyValue("--fg-1").trim(),
        font: styles.getPropertyValue("--font-ui").trim(),
        caption: notes.length === 0 ? null : notes.join(" · "),
      },
    );
    const blob = await new Promise<Blob | null>((resolve) => {
      composed.toBlob(resolve, "image/png");
    });
    return blob === null ? null : new Uint8Array(await blob.arrayBuffer());
  }

  /** Shows each tab in turn so every panel renders, then restores the view. */
  private async allPanelPngs(): Promise<string | null> {
    const exporter = this.host.plane.exporter;
    if (exporter === null) return null;
    const directory = await exporter.pickDirectory();
    if (directory === null) return null;
    const workspace = this.host.workspace;
    const targets = panelPngTargets(workspace.tabs());
    const viewState = workspace.captureViewState();
    let activeTabId: string | null = null;
    try {
      for (const target of targets) {
        if (target.tabId !== activeTabId) {
          if (!workspace.showTabForExport(target.tabId)) {
            throw new Error(`workspace ${target.tabId} is unavailable`);
          }
          activeTabId = target.tabId;
          await this.host.presentWorkspace();
        }
        const bytes = await this.panelPng(target.panelId);
        if (bytes === null) {
          throw new Error(`panel ${target.panelId} could not be rendered`);
        }
        try {
          await exporter.saveFileToDirectory(
            directory,
            target.fileName,
            "png",
            toBase64(bytes),
          );
        } catch (error: unknown) {
          const message =
            error instanceof Error ? error.message : String(error);
          throw new Error(`failed to export ${target.fileName}: ${message}`);
        }
      }
      return directory;
    } finally {
      workspace.restoreViewState(viewState);
      await this.host.presentWorkspace();
    }
  }

  private async focusedCsv(
    fidelity: ExportFidelity,
  ): Promise<CsvExport | null> {
    const panelId = this.host.workspace.focusedPanelId();
    if (panelId === null) return null;
    const panel = this.host.workspace.panel(panelId);
    if (panel === undefined) return null;
    const plane = this.host.plane;
    if (panel.content.kind === "histogram") {
      const capture = plane.histogramCaptures?.find(
        (entry) => entry.panel_id === panel.id,
      );
      const ids =
        capture?.response.series.map((series) => series.signal_id) ??
        this.host.panelSignalIds(panel).ids;
      if (ids.length === 0) return null;
      const response = await plane.queryHistogram({
        request_id: crypto.randomUUID(),
        signal_ids: ids,
        window: capture?.response.window ?? this.host.effectiveWindow(panel),
        bin_count: panel.content.bin_count,
      });
      return buildHistogramCsv(response);
    }
    // X and color signals share each Y's timebase, so writing them as columns
    // keeps the exact pairs an XY or scatter panel plots.
    const bindings = this.host.panelSignalIds(panel);
    if (bindings.ids.length === 0) return null;
    const ids = [
      ...new Set([
        ...(bindings.groups?.map((group) => group.xId) ??
          (bindings.xId === null ? [] : [bindings.xId])),
        ...bindings.ids,
        ...(bindings.groups?.flatMap((group) =>
          Object.values(group.colorIds ?? {}),
        ) ?? []),
      ]),
    ];
    const window = this.host.effectiveWindow(panel);
    const response = await plane.querySamples({
      request_id: crypto.randomUUID(),
      signal_ids: ids,
      window,
      max_points: csvMaxPoints(fidelity),
    });
    const byId = new Map(
      response.series.map((series) => [series.signal_id, series]),
    );
    const ordered = ids
      .map((id) => byId.get(id))
      .filter((series): series is SampleSeries => series !== undefined);
    return buildCsv(ordered, window);
  }
}

function exportSourceOptions(
  signals: readonly SignalSummary[],
): { key: string; label: string }[] {
  const sources = new Map<string, string>();
  for (const signal of signals) {
    if (sources.has(signal.source_key)) continue;
    const suffix = `/${signal.local_path}`;
    const label = signal.path.endsWith(suffix)
      ? signal.path.slice(0, -suffix.length)
      : signal.path;
    sources.set(signal.source_key, label);
  }
  return [...sources]
    .map(([key, label]) => ({ key, label }))
    .sort((left, right) => left.label.localeCompare(right.label));
}
