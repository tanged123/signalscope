import { queryLineGroups } from "./line-query";
import type { LineBindings } from "./line-bindings";
import type { ColumnarTileResponse } from "./bin-columns";
import type { DataPlane } from "./data-plane";
import type { Line2DResponse } from "./line-binary";
import {
  autoPresentationBudgets,
  CPU_BYTES_PER_BIN,
  CPU_BYTES_PER_LINE2D_VALUE,
  GPU_BYTES_PER_BIN,
  GPU_BYTES_PER_LINE2D_VALUE,
  planPresentationDensity,
  type DensityPlan,
} from "./presentation-budget";
import { Line2DWindowCache, TileWindowCache } from "./tile-window-cache";
import type { PanelState } from "../generated/session";
import type { GpuContext } from "../render/gpu-context";
import { prepareTimeTiles } from "../render/time-adapter";
import { prepareSignalXLine } from "../render/signal-x-adapter";

export type PanelLineResponse =
  | { kind: "time"; response: ColumnarTileResponse }
  | { kind: "signal"; response: Line2DResponse };

export interface LinePresentationCallbacks {
  panels(): readonly PanelState[];
  workspaceWidth(): number;
  panelWidth(panelId: string): number;
  signalIds(panel: PanelState): LineBindings;
  windowFor(panel: PanelState): { t0: number; t1: number };
  defaultWindow(): { t0: number; t1: number };
  gpu(): GpuContext | null;
  render(
    responses: ReadonlyMap<string, PanelLineResponse>,
    windowFor: (panelId: string) => { t0: number; t1: number },
    missingFor: (panelId: string) => readonly string[],
    errorFor: (panelId: string) => string | null,
  ): number;
  onPlan(plan: DensityPlan): void;
  onRender(elapsed: number): void;
  onError(error: unknown): void;
}

/** Owns the current Line2D tile query, retention, and atomic publication path. */
export class LinePresentationController {
  private readonly cache = new TileWindowCache();
  private readonly signalXCache = new Line2DWindowCache();
  private responsesByPanel = new Map<string, PanelLineResponse>();
  private missingByPanel = new Map<string, string[]>();
  private errorsByPanel = new Map<string, string>();
  private refreshToken = 0;
  private refreshPromise: Promise<void> | null = null;
  private refreshQueued = false;
  private renderFrame: number | null = null;
  private refreshTimer: number | null = null;
  private refreshAbort: AbortController | null = null;
  private disposed = false;

  constructor(
    private readonly plane: DataPlane,
    private readonly callbacks: LinePresentationCallbacks,
  ) {}

  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.refreshQueued = true;
    this.refreshToken += 1;
    this.refreshAbort?.abort();
    if (this.refreshPromise !== null) return this.refreshPromise;
    this.refreshPromise = (async () => {
      try {
        while (this.refreshQueued) {
          this.refreshQueued = false;
          this.refreshAbort = new AbortController();
          await this.refreshPass(this.refreshToken, this.refreshAbort.signal);
        }
      } finally {
        this.refreshAbort = null;
        this.refreshPromise = null;
      }
    })();
    return this.refreshPromise;
  }

  render(): void {
    if (this.disposed) return;
    try {
      const panels = new Map(
        this.callbacks.panels().map((panel) => [panel.id, panel]),
      );
      const elapsed = this.callbacks.render(
        this.responsesByPanel,
        (panelId) => {
          const panel = panels.get(panelId);
          return panel === undefined
            ? this.callbacks.defaultWindow()
            : this.callbacks.windowFor(panel);
        },
        (panelId) => this.missingByPanel.get(panelId) ?? [],
        (panelId) => this.errorsByPanel.get(panelId) ?? null,
      );
      this.callbacks.onRender(elapsed);
    } catch (error: unknown) {
      this.callbacks.onError(error);
    }
  }

  scheduleRender(): void {
    if (this.disposed || this.renderFrame !== null) return;
    this.renderFrame = requestAnimationFrame(() => {
      this.renderFrame = null;
      this.render();
    });
  }

  scheduleRefresh(delay = 50): void {
    if (this.disposed) return;
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, delay);
  }

  resized(): void {
    this.scheduleRender();
    this.scheduleRefresh();
  }

  publishCachedCoverage(): void {
    let next: Map<string, PanelLineResponse> | null = null;
    for (const panel of this.callbacks.panels()) {
      const window = this.callbacks.windowFor(panel);
      const current = this.responsesByPanel.get(panel.id);
      if (panel.x_axis.kind !== "time") {
        const response = this.signalXCache.coveringCurrent(panel.id, window);
        if (response === null) continue;
        prepareSignalXLine(response, window);
        if (current?.response === response) continue;
        next ??= new Map(this.responsesByPanel);
        next.set(panel.id, { kind: "signal", response });
      } else {
        const response = this.cache.coveringCurrent(panel.id, window);
        if (response === null || current?.response === response) continue;
        next ??= new Map(this.responsesByPanel);
        next.set(panel.id, { kind: "time", response });
      }
    }
    if (next !== null) this.responsesByPanel = next;
  }

  invalidate(panelId?: string): void {
    this.refreshToken += 1;
    this.refreshAbort?.abort();
    this.cache.invalidate(panelId);
    this.signalXCache.invalidate(panelId);
    if (panelId === undefined) {
      this.responsesByPanel.clear();
      this.missingByPanel.clear();
      this.errorsByPanel.clear();
    } else {
      this.responsesByPanel.delete(panelId);
      this.missingByPanel.delete(panelId);
      this.errorsByPanel.delete(panelId);
    }
  }

  clear(): void {
    this.refreshQueued = false;
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    if (this.renderFrame !== null) cancelAnimationFrame(this.renderFrame);
    this.refreshTimer = null;
    this.renderFrame = null;
    this.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  responses(): Iterable<PanelLineResponse> {
    return this.responsesByPanel.values();
  }

  private async refreshPass(
    refreshToken: number,
    signal: AbortSignal,
  ): Promise<void> {
    const panels = this.callbacks.panels();
    const fallbackWidth = Math.max(
      1,
      Math.round(this.callbacks.workspaceWidth()),
    );
    const devicePixelRatio = Number.isFinite(window.devicePixelRatio)
      ? window.devicePixelRatio
      : 1;
    const panelInputs = panels.map((panel) => {
      const signals = this.callbacks.signalIds(panel);
      const window = this.callbacks.windowFor(panel);
      const panelWidth = this.callbacks.panelWidth(panel.id);
      const pixelWidth =
        panelWidth > 0 ? Math.round(panelWidth) : fallbackWidth;
      const paddedWindow = TileWindowCache.padWindow(window.t0, window.t1);
      const span = window.t1 - window.t0;
      const paddingRatio =
        span > 0 ? (paddedWindow.t1 - paddedWindow.t0) / span : 1;
      return { panel, signals, window, paddedWindow, pixelWidth, paddingRatio };
    });
    const adapterLimits = (
      this.callbacks.gpu()?.adapter as
        | { limits?: { maxBufferSize?: unknown } }
        | undefined
    )?.limits;
    const budgets = autoPresentationBudgets(
      Number(adapterLimits?.maxBufferSize ?? 0),
      (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
    );
    const replacing = new Set(panels.map((panel) => panel.id));
    const retainedTileUnits = this.cache.retainedBinCount(replacing);
    const retainedLineUnits =
      this.signalXCache.retainedResourceUnitCount(replacing);
    const densityPlan = planPresentationDensity({
      demands: panelInputs.map((input) => ({
        panelId: input.panel.id,
        physicalPixels: input.pixelWidth * devicePixelRatio,
        paddingRatio: input.paddingRatio,
        visibleSeries:
          input.signals.ids.length +
          (input.panel.x_axis.kind !== "time"
            ? 2 * (input.signals.groups?.length ?? 1)
            : 0),
        reductionExpansion:
          input.panel.x_axis.kind !== "time"
            ? 4 +
              2 *
                Math.max(
                  0,
                  ...(input.signals.groups?.map(
                    (group) => group.ids.length,
                  ) ?? [input.signals.ids.length]),
                )
            : 1,
        cpuBytesPerUnit:
          input.panel.x_axis.kind !== "time"
            ? CPU_BYTES_PER_LINE2D_VALUE
            : CPU_BYTES_PER_BIN,
        gpuBytesPerUnit:
          input.panel.x_axis.kind !== "time"
            ? GPU_BYTES_PER_LINE2D_VALUE
            : GPU_BYTES_PER_BIN,
      })),
      budgets,
      retainedCpuBytes:
        retainedTileUnits * CPU_BYTES_PER_BIN +
        retainedLineUnits * CPU_BYTES_PER_LINE2D_VALUE,
      retainedGpuBytes:
        retainedTileUnits * GPU_BYTES_PER_BIN +
        retainedLineUnits * GPU_BYTES_PER_LINE2D_VALUE,
    });
    this.callbacks.onPlan(densityPlan);
    const nextResponses = new Map<string, PanelLineResponse>();
    const nextMissing = new Map<string, string[]>();
    const nextErrors = new Map<string, string>();
    const replacements = new Map<
      string,
      {
        data: PanelLineResponse;
        window: { t0: number; t1: number };
        pixelWidth: number;
        requestedDevicePixels: number;
        idsKey: string;
        viewWindow: { t0: number; t1: number };
      }
    >();
    await Promise.all(
      panelInputs.map(async (input) => {
        const { panel, signals, window, paddedWindow, pixelWidth } = input;
        const { ids, missing } = signals;
        nextMissing.set(panel.id, missing);
        const signalX = panel.x_axis.kind !== "time";
        if (ids.length === 0 || (signalX && signals.xId === null)) return;
        const desiredDevicePixels = Math.max(
          1,
          Math.ceil((pixelWidth * devicePixelRatio * densityPlan.density) / 2),
        );
        const idsKey = [
          signalX ? "signal" : "time",
          JSON.stringify(signals.groups ?? signals.xId),
          ...(signalX ? ids : [...ids].sort()),
        ].join("\u0000");
        const lookup = signalX
          ? this.signalXCache.lookup(
              panel.id,
              idsKey,
              window,
              desiredDevicePixels,
            )
          : this.cache.lookup(panel.id, idsKey, window, desiredDevicePixels);
        if (lookup.kind === "current") {
          if (signalX) {
            prepareSignalXLine(lookup.response as Line2DResponse, window);
          }
          nextResponses.set(panel.id, {
            kind: signalX ? "signal" : "time",
            response: lookup.response,
          } as PanelLineResponse);
          return;
        }
        const fallback = lookup.kind === "stale" ? lookup.response : null;
        const requestedDevicePixels = densityPlan.requests.get(panel.id) ?? 1;
        try {
          const data: PanelLineResponse = signalX
            ? {
                kind: "signal",
                response: await queryLineGroups(
                  this.plane,
                  signals.groups ?? [{ xId: signals.xId as string, ids }],
                  paddedWindow,
                  requestedDevicePixels,
                  signal,
                ),
              }
            : {
                kind: "time",
                response: await this.plane.queryTiles(
                  {
                    request_id: crypto.randomUUID(),
                    signal_ids: ids,
                    window: paddedWindow,
                    pixel_width: requestedDevicePixels,
                  },
                  signal,
                ),
              };
          if (refreshToken !== this.refreshToken) return;
          replacements.set(panel.id, {
            data,
            window: paddedWindow,
            pixelWidth,
            requestedDevicePixels,
            idsKey,
            viewWindow: window,
          });
          nextResponses.set(panel.id, data);
        } catch (error: unknown) {
          if (refreshToken !== this.refreshToken) return;
          this.callbacks.onError(error);
          nextErrors.set(panel.id, errorMessage(error));
          if (fallback !== null) {
            if (signalX) {
              prepareSignalXLine(fallback as Line2DResponse, window);
            }
            nextResponses.set(panel.id, {
              kind: signalX ? "signal" : "time",
              response: fallback,
            } as PanelLineResponse);
          }
        }
      }),
    );
    if (refreshToken !== this.refreshToken) return;
    try {
      for (const replacement of replacements.values()) {
        if (replacement.data.kind === "time") {
          prepareTimeTiles(replacement.data.response);
        } else {
          prepareSignalXLine(replacement.data.response, replacement.viewWindow);
        }
      }
    } catch (error: unknown) {
      if (refreshToken === this.refreshToken) this.callbacks.onError(error);
      return;
    }
    for (const [panelId, replacement] of replacements) {
      const entry = {
        window: replacement.window,
        pixelWidth: replacement.pixelWidth,
        requestedDevicePixels: replacement.requestedDevicePixels,
        idsKey: replacement.idsKey,
      };
      if (replacement.data.kind === "time") {
        this.cache.store(panelId, {
          ...entry,
          response: replacement.data.response,
        });
      } else {
        this.signalXCache.store(panelId, {
          ...entry,
          response: replacement.data.response,
        });
      }
    }
    this.responsesByPanel = nextResponses;
    this.missingByPanel = nextMissing;
    this.errorsByPanel = nextErrors;
    this.render();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
