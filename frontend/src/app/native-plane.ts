import type {
  BatchDetail,
  BatchDetailRequest,
  BatchJob,
  BatchStatus,
  ContainerOutline,
  CreateDerivedBundleRequest,
  DerivedBundleResponse,
  DerivedRequest,
  DragDropForward,
  ExportEstimate,
  ExportEstimateRequest,
  ExportWriteAtPathRequest,
  ExportWriteRequest,
  FormatDescriptor,
  IngestBatchRequest,
  IntrospectRequest,
  LoadedSession,
  LoadSessionRequest,
  RemoveDerivedBundleRequest,
  RemoveSignalRequest,
  RestoreReconcileRequest,
  RestoreReconcileResponse,
  RestoreSourcesRequest,
  SampleRequest,
  SampleResponse,
  SaveRecipeRequest,
  SaveRecipeResponse,
  SaveSessionRequest,
  ScanSourcesRequest,
  ScanSourcesResponse,
  SignalSummary,
  SourceSummary,
  TileRequest,
} from "../generated/protocol";
import {
  type DataPlane,
  type DerivedPort,
  type ExportPort,
  type IngestPort,
  type PreferencesPort,
  type RestorePort,
  type SessionPort,
} from "./data-plane";
import type { ScopeDesktopBridge } from "./desktop-bridge";
import { open, seal } from "./envelope";
import { NativeClient } from "./native-client";
import { decodeTileResponse } from "./tile-binary";

function response<T>(
  value: Promise<{ protocol_version: number; payload: T }>,
): Promise<T> {
  return value.then(open);
}

function sampleResponse(value: SampleResponse): SampleResponse {
  return {
    ...value,
    series: value.series.map((series) => ({
      ...series,
      values: series.values.map((sample) =>
        typeof sample === "number" && Number.isFinite(sample)
          ? sample
          : Number.NaN,
      ),
    })),
  };
}

export class NativePlane implements DataPlane {
  readonly sourceLabel = "native data plane";
  readonly ingest: IngestPort;
  readonly derived: DerivedPort;
  readonly session: SessionPort;
  readonly restore: RestorePort;
  readonly preferences: PreferencesPort;
  readonly exporter: ExportPort;

  private constructor(
    private readonly client: NativeClient,
    bridge: ScopeDesktopBridge,
  ) {
    this.ingest = {
      pickSources: async () => {
        const formats = await this.listFormats();
        return bridge.pickSources(formats);
      },
      pickSourceFolder: () => bridge.pickSourceFolder(),
      scanSources: (path, recursive) =>
        response(
          client.json<ScanSourcesRequest, ScanSourcesResponse>(
            "/v1/ingest/scan",
            seal({ path, recursive }),
          ),
        ),
      startBatch: (paths) =>
        response(
          client.json<IngestBatchRequest, BatchJob>(
            "/v1/ingest/start",
            seal({ paths }),
          ),
        ).then((job) => job.job_id),
      batchStatus: (jobId) =>
        response(
          client.json<BatchJob, BatchStatus>(
            "/v1/ingest/status",
            seal({ job_id: jobId }),
          ),
        ),
      batchDetail: (jobId, offset, limit) =>
        response(
          client.json<BatchDetailRequest, BatchDetail>(
            "/v1/ingest/detail",
            seal({ job_id: jobId, offset, limit }),
          ),
        ),
      cancelBatch: (jobId) =>
        response(
          client.json<BatchJob, null>(
            "/v1/ingest/cancel",
            seal({ job_id: jobId }),
          ),
        ).then(() => undefined),
      releaseBatch: (jobId) =>
        response(
          client.json<BatchJob, null>(
            "/v1/ingest/release",
            seal({ job_id: jobId }),
          ),
        ).then(() => undefined),
      listFormats: () => this.listFormats(),
      introspect: (path) =>
        response(
          client.json<IntrospectRequest, ContainerOutline>(
            "/v1/ingest/introspect",
            seal({ path }),
          ),
        ),
      saveRecipe: (path, recipeToml, destination) =>
        response(
          client.json<SaveRecipeRequest, SaveRecipeResponse>(
            "/v1/ingest/recipe",
            seal({ path, recipe_toml: recipeToml, destination }),
          ),
        ),
      onDragDrop: (handler: (event: DragDropForward) => void) =>
        bridge.onDragDrop(handler),
    };
    this.derived = {
      create: (path, expr) =>
        response(
          client.json<DerivedRequest, SignalSummary>(
            "/v1/derived/create",
            seal({ path, expr }),
          ),
        ),
      remove: (path) =>
        response(
          client.json<RemoveSignalRequest, null>(
            "/v1/derived/remove",
            seal({ path }),
          ),
        ).then(() => undefined),
      createBundle: (name, expr) =>
        response(
          client.json<CreateDerivedBundleRequest, DerivedBundleResponse>(
            "/v1/derived-bundle/create",
            seal({ name, expr }),
          ),
        ),
      removeBundle: (name) =>
        response(
          client.json<RemoveDerivedBundleRequest, null>(
            "/v1/derived-bundle/remove",
            seal({ name }),
          ),
        ).then(() => undefined),
    };
    this.session = {
      save: (sessionJson, path) =>
        response(
          client.json<SaveSessionRequest, string>(
            "/v1/session/save",
            seal({ session_json: sessionJson, path }),
          ),
        ),
      load: (path) =>
        response(
          client.json<LoadSessionRequest, LoadedSession>(
            "/v1/session/load",
            seal({ path }),
          ),
        ),
      reset: () =>
        response(
          client.json<null, LoadedSession>("/v1/session/reset", seal(null)),
        ),
      pick: (mode) => bridge.pickSession(mode),
    };
    this.restore = {
      start: (sessionJson) =>
        response(
          client.json<RestoreSourcesRequest, BatchJob>(
            "/v1/ingest/restore",
            seal({ session_json: sessionJson }),
          ),
        ).then((job) => job.job_id),
      reconcile: (sessionJson, jobId) =>
        response(
          client.json<RestoreReconcileRequest, RestoreReconcileResponse>(
            "/v1/ingest/restore-reconcile",
            seal({ session_json: sessionJson, job_id: jobId }),
          ),
        ),
    };
    this.preferences = {
      load: () =>
        response(
          client.json<null, string | null>("/v1/preferences/load", seal(null)),
        ),
      save: (preferencesJson) =>
        response(
          client.json<string, null>(
            "/v1/preferences/save",
            seal(preferencesJson),
          ),
        ).then(() => undefined),
      effectiveRecipeDirectory: () =>
        response(
          client.json<null, string>(
            "/v1/preferences/recipe-directory",
            seal(null),
          ),
        ),
      pickRecipeDirectory: () => bridge.pickDirectory("recipe"),
    };
    this.exporter = {
      estimate: (sessionJson, selection) =>
        response(
          client.json<ExportEstimateRequest, ExportEstimate>(
            "/v1/export/estimate",
            seal({ session_json: sessionJson, selection }),
          ),
        ),
      writeHtml: async (sessionJson, range, fidelity, selection) => {
        const destination = await bridge.pickExportFile(
          "snapshot.html",
          "html",
        );
        if (destination === null) return null;
        const request: ExportWriteRequest = {
          session_json: sessionJson,
          range,
          fidelity,
          selection,
        };
        return response(
          client.json<ExportWriteAtPathRequest, string | null>(
            "/v1/export/write",
            seal({ request, destination }),
          ),
        );
      },
      saveFile: async (fileName, kind, bytes) => {
        const destination = await bridge.pickExportFile(fileName, kind);
        if (destination === null) return null;
        return response(
          client.writeFile(
            seal({
              destination: "exact_path",
              path: destination,
              file_name: "",
              kind,
            }),
            bytes,
          ),
        );
      },
      pickDirectory: () => bridge.pickDirectory("export"),
      saveFileToDirectory: (directory, fileName, kind, bytes) =>
        response(
          client.writeFile(
            seal({
              destination: "directory",
              path: directory,
              file_name: fileName,
              kind,
            }),
            bytes,
          ),
        ),
    };
  }

  static async create(bridge: ScopeDesktopBridge): Promise<NativePlane> {
    const connection = await bridge.connect();
    return new NativePlane(new NativeClient(connection), bridge);
  }

  private listFormats(): Promise<FormatDescriptor[]> {
    return response(
      this.client.json<null, FormatDescriptor[]>(
        "/v1/catalog/formats",
        seal(null),
      ),
    );
  }

  listSignals(): Promise<SignalSummary[]> {
    return response(
      this.client.json<null, SignalSummary[]>(
        "/v1/catalog/signals",
        seal(null),
      ),
    );
  }

  listSources(): Promise<SourceSummary[]> {
    return response(
      this.client.json<null, SourceSummary[]>(
        "/v1/catalog/sources",
        seal(null),
      ),
    );
  }

  async queryTiles(request: TileRequest) {
    return decodeTileResponse(
      await this.client.tiles(seal(request)),
      request.request_id,
    );
  }

  async querySamples(request: SampleRequest): Promise<SampleResponse> {
    return sampleResponse(
      await response(
        this.client.json<SampleRequest, SampleResponse>(
          "/v1/query/samples",
          seal(request),
        ),
      ),
    );
  }
}
