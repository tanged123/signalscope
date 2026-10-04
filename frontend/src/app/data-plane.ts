import {
  type BakedHistogram,
  type HistogramRequest,
  type HistogramResponse,
  type BatchDetail,
  type BatchJob,
  type BatchStatus,
  type ContainerOutline,
  type DerivedBundleResponse,
  type ExportEstimate,
  type ExportFidelity,
  type ExportFileKind,
  type ExportRange,
  type ExportSelection,
  type FormatDescriptor,
  type LoadedSession,
  type Line2DRequest,
  type RestoreFinalizeResponse,
  type RecipeDestination,
  type SaveRecipeResponse,
  type SampleRequest,
  type SampleResponse,
  type ScanSourcesResponse,
  type SessionDialogMode,
  type SignalSummary,
  type SourceSummary,
  type TileRequest,
} from "../generated/protocol";
import type { ColumnarTileResponse } from "./bin-columns";
import { open, seal, type Envelope } from "./envelope";
import { decodeTileResponse } from "./tile-binary";
import { decodeLineResponse, type Line2DResponse } from "./line-binary";
import { validateHistogramResponse } from "./histogram-data";
import { BakedPlane } from "./baked-plane";

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
  finalize(
    sessionJson: string,
    jobId: string,
  ): Promise<RestoreFinalizeResponse>;
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
    preferencesJson?: string,
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
  readonly histogramCaptures?: readonly BakedHistogram[];
  readonly sourceLabel: string;
  readonly ingest: IngestPort | null;
  readonly derived: DerivedPort | null;
  readonly session: SessionPort | null;
  readonly restore: RestorePort | null;
  readonly preferences: PreferencesPort | null;
  readonly exporter: ExportPort | null;
  readonly bakedSessionJson?: string;
  readonly bakedPreferencesJson?: string;
  listSignals(): Promise<SignalSummary[]>;
  listSources(): Promise<SourceSummary[]>;
  queryTiles(
    request: TileRequest,
    signal?: AbortSignal,
  ): Promise<ColumnarTileResponse>;
  queryLine2D(
    request: Line2DRequest,
    signal?: AbortSignal,
  ): Promise<Line2DResponse>;
  querySamples(request: SampleRequest): Promise<SampleResponse>;
  queryHistogram(
    request: HistogramRequest,
    signal?: AbortSignal,
  ): Promise<HistogramResponse>;
}

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
      finalize: async (sessionJson: string, jobId: string) =>
        this.post<RestoreFinalizeResponse>("restore_finalize", {
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
        preferencesJson?: string,
      ) =>
        this.post<string | null>("export_write", {
          session_json: sessionJson,
          range,
          fidelity,
          selection,
          preferences_json: preferencesJson ?? null,
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

  async queryTiles(
    request: TileRequest,
    signal?: AbortSignal,
  ): Promise<ColumnarTileResponse> {
    return decodeTileResponse(
      await this.postBinary("query_tiles_bin", request, signal),
      request.request_id,
    );
  }

  async queryLine2D(
    request: Line2DRequest,
    signal?: AbortSignal,
  ): Promise<Line2DResponse> {
    return decodeLineResponse(
      await this.postBinary("query_line2d_bin", request, signal),
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

  async queryHistogram(
    request: HistogramRequest,
    signal?: AbortSignal,
  ): Promise<HistogramResponse> {
    const response = await this.post<unknown>(
      "query_histogram",
      request,
      signal,
    );
    return validateHistogramResponse(response, request);
  }

  private async post<T>(
    path: string,
    payload?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.fetcher(`/api/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload === undefined ? null : JSON.stringify(seal(payload)),
      signal: signal ?? null,
    });
    if (!response.ok) {
      throw new Error(await response.text());
    }
    return open((await response.json()) as Envelope<T>);
  }

  private async postBinary(
    path: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer> {
    const response = await this.fetcher(`/api/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(seal(payload)),
      signal: signal ?? null,
    });
    if (!response.ok) {
      throw new Error(await response.text());
    }
    return response.arrayBuffer();
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
