import {
  type BatchDetail,
  type BatchJob,
  type BatchStatus,
  type ContainerOutline,
  type DerivedBundleResponse,
  type EnvelopeBin,
  type ExportEstimate,
  type ExportFidelity,
  type ExportFileKind,
  type ExportRange,
  type ExportSelection,
  type FormatDescriptor,
  type LoadedSession,
  type RestoreReconcileResponse,
  type RecipeDestination,
  type SaveRecipeResponse,
  type SampleRequest,
  type SampleResponse,
  type ScanSourcesResponse,
  type SessionDialogMode,
  type SignalSummary,
  type SnapshotManifest,
  type SourceSummary,
  type TileRequest,
} from "../generated/protocol";
import { SESSION_SCHEMA_VERSION } from "../generated/session";
import {
  binColumnsFromWire,
  binColumnsFromWireRange,
  sliceColumns,
  type BinColumns,
  type ColumnarTileResponse,
} from "./bin-columns";
import { open, seal, type Envelope } from "./envelope";
import { queryRawPyramidRange } from "./pyramid-query";
import { binsToSamples, sampleWindow } from "./samples";
import { decodeTileResponse } from "./tile-binary";

export interface IngestPort {
  pickSources(): Promise<string[]>;
  pickSourceFolder(): Promise<string | null>;
  scanSources(path: string, recursive: boolean): Promise<ScanSourcesResponse>;
  startBatch(paths: string[]): Promise<string>;
  batchStatus(jobId: string): Promise<BatchStatus>;
  batchDetail(
    jobId: string,
    offset: number,
    limit: number,
  ): Promise<BatchDetail>;
  cancelBatch(jobId: string): Promise<void>;
  releaseBatch(jobId: string): Promise<void>;
  listFormats(): Promise<FormatDescriptor[]>;
  introspect(path: string): Promise<ContainerOutline>;
  saveRecipe(
    path: string,
    recipeToml: string,
    destination: RecipeDestination,
  ): Promise<SaveRecipeResponse>;
}

export interface DerivedPort {
  create(path: string, expr: string): Promise<SignalSummary>;
  remove(path: string): Promise<void>;
  createBundle(name: string, expr: string): Promise<DerivedBundleResponse>;
  removeBundle(name: string): Promise<void>;
}

export interface SessionPort {
  save(sessionJson: string, path: string | null): Promise<string>;
  load(path: string | null): Promise<LoadedSession>;
  reset(): Promise<LoadedSession>;
  pick(mode: SessionDialogMode): Promise<string | null>;
}

export interface RestorePort {
  start(sessionJson: string): Promise<string>;
  reconcile(
    sessionJson: string,
    jobId: string,
  ): Promise<RestoreReconcileResponse>;
}

export interface PreferencesPort {
  load(): Promise<string | null>;
  save(preferencesJson: string): Promise<void>;
  /** The recipe directory in use, resolved by the host, never built here. */
  effectiveRecipeDirectory(): Promise<string>;
  pickRecipeDirectory(): Promise<string | null>;
}

export interface ExportPort {
  estimate(
    sessionJson: string,
    selection: ExportSelection,
  ): Promise<ExportEstimate>;
  writeHtml(
    sessionJson: string,
    range: ExportRange,
    fidelity: ExportFidelity,
    selection: ExportSelection,
  ): Promise<string | null>;
  saveFile(
    fileName: string,
    kind: ExportFileKind,
    dataBase64: string,
  ): Promise<string | null>;
  pickDirectory(): Promise<string | null>;
  saveFileToDirectory(
    directory: string,
    fileName: string,
    kind: ExportFileKind,
    dataBase64: string,
  ): Promise<string>;
}

export interface DataPlane {
  readonly sourceLabel: string;
  readonly ingest: IngestPort | null;
  readonly derived: DerivedPort | null;
  readonly session: SessionPort | null;
  readonly restore: RestorePort | null;
  readonly preferences: PreferencesPort | null;
  readonly exporter: ExportPort | null;
  readonly bakedSessionJson?: string;
  listSignals(): Promise<SignalSummary[]>;
  listSources(): Promise<SourceSummary[]>;
  queryTiles(request: TileRequest): Promise<ColumnarTileResponse>;
  querySamples(request: SampleRequest): Promise<SampleResponse>;
}

type BakedManifest = Envelope<SnapshotManifest>;

export class HttpPlane implements DataPlane {
  readonly sourceLabel = "native data plane";

  readonly ingest: IngestPort;

  readonly derived: DerivedPort;
  readonly session: SessionPort;

  readonly restore: RestorePort;

  readonly preferences: PreferencesPort;

  readonly exporter: ExportPort;

  constructor(
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    this.ingest = {
      pickSources: async () => this.post<string[]>("pick_sources"),
      pickSourceFolder: async () =>
        this.post<string | null>("pick_source_folder"),
      scanSources: async (path: string, recursive: boolean) =>
        this.post<ScanSourcesResponse>("scan_sources", { path, recursive }),
      startBatch: async (paths: string[]) =>
        (await this.post<BatchJob>("ingest_batch", { paths })).job_id,
      batchStatus: async (jobId: string) =>
        this.post<BatchStatus>("batch_status", { job_id: jobId }),
      batchDetail: async (jobId: string, offset: number, limit: number) =>
        this.post<BatchDetail>("batch_detail", {
          job_id: jobId,
          offset,
          limit,
        }),
      cancelBatch: async (jobId: string) => {
        await this.post<null>("cancel_batch", { job_id: jobId });
      },
      releaseBatch: async (jobId: string) => {
        await this.post<null>("release_batch", { job_id: jobId });
      },
      listFormats: async () => this.post<FormatDescriptor[]>("list_formats"),
      introspect: async (path: string) =>
        this.post<ContainerOutline>("introspect_container", { path }),
      saveRecipe: async (
        path: string,
        recipeToml: string,
        destination: RecipeDestination,
      ) =>
        this.post<SaveRecipeResponse>("save_recipe", {
          path,
          recipe_toml: recipeToml,
          destination,
        }),
    };
    this.derived = {
      create: async (path: string, expr: string) =>
        this.post<SignalSummary>("create_derived", { path, expr }),
      remove: async (path: string) => {
        await this.post<null>("remove_signal", { path });
      },
      createBundle: async (name: string, expr: string) =>
        this.post<DerivedBundleResponse>("create_derived_bundle", {
          name,
          expr,
        }),
      removeBundle: async (name: string) => {
        await this.post<null>("remove_derived_bundle", { name });
      },
    };
    this.session = {
      save: async (sessionJson: string, path: string | null) =>
        this.post<string>("save_session", { session_json: sessionJson, path }),
      load: async (path: string | null) =>
        this.post<LoadedSession>("load_session", { path }),
      reset: async () => this.post<LoadedSession>("reset_session"),
      pick: async (mode: SessionDialogMode) =>
        this.post<string | null>("pick_session_path", { mode }),
    };
    this.restore = {
      start: async (sessionJson: string) =>
        (
          await this.post<BatchJob>("restore_sources", {
            session_json: sessionJson,
          })
        ).job_id,
      reconcile: async (sessionJson: string, jobId: string) =>
        this.post<RestoreReconcileResponse>("restore_reconcile", {
          session_json: sessionJson,
          job_id: jobId,
        }),
    };
    this.preferences = {
      load: async () => this.post<string | null>("load_preferences"),
      save: async (preferencesJson: string) => {
        await this.post<null>("save_preferences", preferencesJson);
      },
      effectiveRecipeDirectory: async () =>
        this.post<string>("effective_recipe_directory"),
      pickRecipeDirectory: async () =>
        this.post<string | null>("pick_recipe_directory"),
    };
    this.exporter = {
      estimate: async (sessionJson: string, selection: ExportSelection) =>
        this.post<ExportEstimate>("export_estimate", {
          session_json: sessionJson,
          selection,
        }),
      writeHtml: async (
        sessionJson: string,
        range: ExportRange,
        fidelity: ExportFidelity,
        selection: ExportSelection,
      ) =>
        this.post<string | null>("export_write", {
          session_json: sessionJson,
          range,
          fidelity,
          selection,
        }),
      saveFile: async (
        fileName: string,
        kind: ExportFileKind,
        dataBase64: string,
      ) =>
        this.post<string | null>("save_export_file", {
          file_name: fileName,
          kind,
          data_base64: dataBase64,
        }),
      pickDirectory: async () =>
        this.post<string | null>("pick_export_directory"),
      saveFileToDirectory: async (
        directory: string,
        fileName: string,
        kind: ExportFileKind,
        dataBase64: string,
      ) =>
        this.post<string>("save_export_file_to_directory", {
          directory,
          file_name: fileName,
          kind,
          data_base64: dataBase64,
        }),
    };
  }

  async listSignals(): Promise<SignalSummary[]> {
    return this.post<SignalSummary[]>("list_signals");
  }

  async listSources(): Promise<SourceSummary[]> {
    return this.post<SourceSummary[]>("list_sources");
  }

  async queryTiles(request: TileRequest): Promise<ColumnarTileResponse> {
    return decodeTileResponse(
      await this.postBinary("query_tiles_bin", request),
      request.request_id,
    );
  }

  async querySamples(request: SampleRequest): Promise<SampleResponse> {
    const response = await this.post<SampleResponse>("query_samples", request);
    return {
      ...response,
      series: response.series.map((series) => ({
        ...series,
        // JSON represents Rust's non-finite gap samples as null. Restore the
        // data-plane contract before presentation-plane interpolation sees it.
        values: series.values.map((value) =>
          typeof value === "number" && Number.isFinite(value)
            ? value
            : Number.NaN,
        ),
      })),
    };
  }

  private async post<T>(path: string, payload?: unknown): Promise<T> {
    const response = await this.fetcher(`/api/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload === undefined ? null : JSON.stringify(seal(payload)),
    });
    if (!response.ok) {
      throw new Error(await response.text());
    }
    return open((await response.json()) as Envelope<T>);
  }

  private async postBinary(
    path: string,
    payload: unknown,
  ): Promise<ArrayBuffer> {
    const response = await this.fetcher(`/api/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(seal(payload)),
    });
    if (!response.ok) {
      throw new Error(await response.text());
    }
    return response.arrayBuffer();
  }
}

export class BakedPlane implements DataPlane {
  readonly sourceLabel = "baked demo source";

  readonly ingest = null;

  readonly derived = null;
  readonly session = null;

  readonly restore = null;

  readonly preferences = null;

  readonly exporter = null;

  readonly bakedSessionJson: string;

  private readonly payload: BakedManifest["payload"];

  /**
   * Level-0 bins reconstructed as raw samples, per signal id. The mapping is
   * fixed for a baked payload, so it is built on first use rather than on
   * every windowed query.
   */
  private readonly rawSamples = new Map<
    string,
    { time: number[]; values: number[] }
  >();

  private readonly levelColumns = new Map<string, Map<number, BinColumns>>();

  constructor(manifest: BakedManifest) {
    this.payload = open(manifest);
    this.bakedSessionJson = this.payload.session_json;
  }

  static fromDocument(documentRoot: Document = document): BakedPlane {
    const slot = documentRoot.querySelector<HTMLScriptElement>(
      "#signalscope-baked-data",
    );
    const value = slot === null ? null : slot.textContent.trim();
    if (value && value !== "null") {
      return new BakedPlane(JSON.parse(value) as BakedManifest);
    }
    return new BakedPlane(createDemoManifest());
  }

  listSignals(): Promise<SignalSummary[]> {
    return Promise.resolve(
      this.payload.signals.map((signal) => signal.summary),
    );
  }

  listSources(): Promise<SourceSummary[]> {
    const points = this.payload.signals.reduce(
      (total, signal) => total + Number(signal.summary.point_count),
      0,
    );
    return Promise.resolve([
      {
        source_id: "0",
        source_key: "00000000-0000-0000-0000-000000000000",
        prefix: this.payload.signals[0]?.summary.path.split("/")[0] ?? "demo",
        path: this.sourceLabel,
        point_count: String(points),
      },
    ]);
  }

  queryTiles(request: TileRequest): Promise<ColumnarTileResponse> {
    const requested = new Set(request.signal_ids);
    return Promise.resolve({
      requestId: request.request_id,
      series: this.payload.signals
        .filter((signal) => requested.has(signal.summary.signal_id))
        .map((signal) => {
          const range = queryRawPyramidRange(
            signal.levels,
            request.window.t0,
            request.window.t1,
          );
          const bins = this.columnsFor(
            signal,
            range.level,
            range.start,
            range.end,
          );
          return {
            signalId: signal.summary.signal_id,
            signalPath: signal.summary.path,
            unit: signal.summary.unit,
            level: range.level,
            bins,
          };
        }),
    });
  }

  private columnsFor(
    signal: BakedManifest["payload"]["signals"][number],
    level: number,
    start: number,
    end: number,
  ): BinColumns {
    let levels = this.levelColumns.get(signal.summary.signal_id);
    if (levels === undefined) {
      levels = new Map();
      this.levelColumns.set(signal.summary.signal_id, levels);
    }
    let columns = levels.get(level);
    if (columns === undefined) {
      const wire = signal.levels[level] ?? [];
      if (start <= 0 && end >= wire.length) {
        columns = binColumnsFromWire(wire);
        levels.set(level, columns);
        return columns;
      }
      return binColumnsFromWireRange(wire, start, end);
    }
    return sliceColumns(columns, start, end);
  }

  querySamples(request: SampleRequest): Promise<SampleResponse> {
    const requested = new Set(request.signal_ids);
    return Promise.resolve({
      request_id: request.request_id,
      series: this.payload.signals
        .filter((signal) => requested.has(signal.summary.signal_id))
        .map((signal) => {
          const raw = this.rawFor(signal);
          const slice = sampleWindow(
            raw.time,
            raw.values,
            request.window.t0,
            request.window.t1,
            request.max_points,
          );
          return {
            signal_id: signal.summary.signal_id,
            signal_path: signal.summary.path,
            unit: signal.summary.unit,
            time: slice.time,
            values: slice.values,
            stride: slice.stride,
          };
        }),
    });
  }

  /** ADR 0015: the finest baked level stands in for raw samples. */
  private rawFor(signal: BakedManifest["payload"]["signals"][number]): {
    time: number[];
    values: number[];
  } {
    const id = signal.summary.signal_id;
    let raw = this.rawSamples.get(id);
    if (raw === undefined) {
      raw = binsToSamples(signal.levels[0] ?? []);
      this.rawSamples.set(id, raw);
    }
    return raw;
  }
}

export async function selectDataPlane(): Promise<DataPlane> {
  const bakedSlot = document.querySelector<HTMLScriptElement>(
    "#signalscope-baked-data",
  );
  if (bakedSlot !== null && bakedSlot.textContent.trim() !== "null") {
    return BakedPlane.fromDocument();
  }
  try {
    const response = await fetch("/api/health", {
      signal: AbortSignal.timeout(1500),
    });
    if (response.ok) return new HttpPlane();
  } catch {
    // A static export may be opened without its development server.
  }
  return BakedPlane.fromDocument();
}

function createDemoManifest(): BakedManifest {
  const pointCount = 1_800;
  const makeBins = (
    transform: (time: number, index: number) => number,
  ): EnvelopeBin[] =>
    Array.from({ length: pointCount }, (_, index) => {
      const time = index / 30;
      const value = transform(time, index);
      return {
        t0: time,
        t1: time,
        first: value,
        last: value,
        min: value,
        max: value,
        sum: Number.isFinite(value) ? value : 0,
        sum_sq: Number.isFinite(value) ? value * value : 0,
        finite_count: Number.isFinite(value) ? "1" : "0",
        sample_count: "1",
        has_gap: false,
      };
    });

  const demoSignals: {
    summary: SignalSummary;
    generate: (time: number) => number;
  }[] = [
    {
      summary: {
        signal_id: "1",
        source_id: "0",
        source_key: "00000000-0000-0000-0000-000000000000",
        local_path: "velocity_body/x",
        path: "rocket/velocity_body/x",
        unit: "m/s",
        point_count: String(pointCount),
        t_min: 0,
        t_max: (pointCount - 1) / 30,
        last_value: null,
      },
      generate: (time) =>
        145 * Math.sin(time * 0.14) + 58 * Math.sin(time * 0.47) + time * 1.3,
    },
    {
      summary: {
        signal_id: "2",
        source_id: "0",
        source_key: "00000000-0000-0000-0000-000000000000",
        local_path: "velocity_body/y",
        path: "rocket/velocity_body/y",
        unit: "m/s",
        point_count: String(pointCount),
        t_min: 0,
        t_max: (pointCount - 1) / 30,
        last_value: null,
      },
      generate: (time) =>
        54 * Math.cos(time * 0.19) + 26 * Math.sin(time * 0.63),
    },
  ];
  return seal({
    session_json: JSON.stringify({
      app: "signalscope",
      schema_version: SESSION_SCHEMA_VERSION,
      theme: "dark",
      linked_time: {
        t0: 0,
        t1: 1,
        linked: true,
        paused: false,
        cursorT: null,
        mode: "fixed",
      },
      active_tab_id: "workspace-1",
      tabs: [
        {
          id: "workspace-1",
          title: "Workspace 1",
          cursor_mode: "none",
          focused_panel_id: null,
          maximized_panel_id: null,
          panels: [],
          layout: [],
        },
      ],
      named_sets: [],
      derived: [],
      derived_bundles: [],
      sources: [],
    }),
    signals: demoSignals.map(({ summary, generate }) => ({
      summary: { ...summary, last_value: generate(summary.t_max) },
      levels: buildDemoLevels(makeBins(generate)),
    })),
  });
}

function buildDemoLevels(levelZero: EnvelopeBin[]): EnvelopeBin[][] {
  const levels = [levelZero];
  let current = levelZero;
  while (current.length > 1) {
    const next: EnvelopeBin[] = [];
    for (let index = 0; index < current.length; index += 2) {
      const left = current[index];
      const right = current[index + 1];
      if (left === undefined) continue;
      next.push(right === undefined ? left : mergeDemoBins(left, right));
    }
    levels.push(next);
    current = next;
  }
  return levels;
}

function mergeDemoBins(left: EnvelopeBin, right: EnvelopeBin): EnvelopeBin {
  return {
    t0: left.t0,
    t1: right.t1,
    first: left.first ?? right.first,
    last: right.last ?? left.last,
    min: minOrNull(left.min, right.min),
    max: maxOrNull(left.max, right.max),
    sum: left.sum + right.sum,
    sum_sq: left.sum_sq + right.sum_sq,
    finite_count: String(
      Number(left.finite_count) + Number(right.finite_count),
    ),
    sample_count: String(
      Number(left.sample_count) + Number(right.sample_count),
    ),
    has_gap: left.has_gap || right.has_gap,
  };
}

function minOrNull(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.min(left, right);
}

function maxOrNull(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}
