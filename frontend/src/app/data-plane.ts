import {
  type DerivedRequest,
  type EnvelopeBin,
  type IngestJob,
  type IngestRequest,
  type IngestStatus,
  type RemoveSignalRequest,
  type SampleRequest,
  type SampleResponse,
  type SignalSummary,
  type SourceSummary,
  type TileRequest,
  type TileResponse,
} from "../generated/protocol";
import { open, seal, type Envelope } from "./envelope";
import { queryPyramid } from "./pyramid-query";
import { binsToSamples, sampleWindow } from "./samples";

export interface IngestPort {
  pickSources(): Promise<string[]>;
  start(path: string): Promise<string>;
  status(jobId: string): Promise<IngestStatus>;
}

export interface DerivedPort {
  create(path: string, expr: string): Promise<SignalSummary>;
  remove(path: string): Promise<void>;
}

export interface DataPlane {
  readonly sourceLabel: string;
  readonly ingest: IngestPort | null;
  readonly derived: DerivedPort | null;
  listSignals(): Promise<SignalSummary[]>;
  listSources(): Promise<SourceSummary[]>;
  queryTiles(request: TileRequest): Promise<TileResponse>;
  querySamples(request: SampleRequest): Promise<SampleResponse>;
}

interface BakedSignal {
  summary: SignalSummary;
  levels: EnvelopeBin[][];
}

type BakedManifest = Envelope<{ signals: BakedSignal[] }>;

interface TauriInternals {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: TauriInternals;
  }
}

export class TauriPlane implements DataPlane {
  readonly sourceLabel = "native data plane";

  readonly ingest: IngestPort;

  readonly derived: DerivedPort;

  constructor(private readonly invoke: TauriInternals["invoke"]) {
    this.ingest = {
      pickSources: async () =>
        open(await this.invoke<Envelope<string[]>>("pick_sources")),
      start: async (path: string) =>
        open(
          await this.invoke<Envelope<IngestJob>>("ingest_source", {
            request: seal<IngestRequest>({ path }),
          }),
        ).job_id,
      status: async (jobId: string) =>
        open(
          await this.invoke<Envelope<IngestStatus>>("ingest_status", {
            request: seal<IngestJob>({ job_id: jobId }),
          }),
        ),
    };
    this.derived = {
      create: async (path: string, expr: string) =>
        open(
          await this.invoke<Envelope<SignalSummary>>("create_derived", {
            request: seal<DerivedRequest>({ path, expr }),
          }),
        ),
      remove: async (path: string) => {
        open(
          await this.invoke<Envelope<null>>("remove_signal", {
            request: seal<RemoveSignalRequest>({ path }),
          }),
        );
      },
    };
  }

  async listSignals(): Promise<SignalSummary[]> {
    return open(await this.invoke<Envelope<SignalSummary[]>>("list_signals"));
  }

  async listSources(): Promise<SourceSummary[]> {
    return open(await this.invoke<Envelope<SourceSummary[]>>("list_sources"));
  }

  async queryTiles(request: TileRequest): Promise<TileResponse> {
    return open(
      await this.invoke<Envelope<TileResponse>>("query_tiles", {
        request: seal(request),
      }),
    );
  }

  async querySamples(request: SampleRequest): Promise<SampleResponse> {
    const response = open(
      await this.invoke<Envelope<SampleResponse>>("query_samples", {
        request: seal(request),
      }),
    );
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
}

export class BakedPlane implements DataPlane {
  readonly sourceLabel = "baked demo source";

  readonly ingest = null;

  readonly derived = null;

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

  constructor(manifest: BakedManifest) {
    this.payload = open(manifest);
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
      { source_id: "0", path: this.sourceLabel, point_count: String(points) },
    ]);
  }

  queryTiles(request: TileRequest): Promise<TileResponse> {
    const requested = new Set(request.signal_ids);
    return Promise.resolve({
      request_id: request.request_id,
      series: this.payload.signals
        .filter((signal) => requested.has(signal.summary.signal_id))
        .map((signal) => {
          const query = queryPyramid(
            signal.levels,
            request.window.t0,
            request.window.t1,
            request.pixel_width,
          );
          return {
            signal_id: signal.summary.signal_id,
            signal_path: signal.summary.path,
            unit: signal.summary.unit,
            level: query.level,
            bins: query.bins,
          };
        }),
    });
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

export function selectDataPlane(): DataPlane {
  const internals = window.__TAURI_INTERNALS__;
  return internals === undefined
    ? BakedPlane.fromDocument()
    : new TauriPlane(internals.invoke.bind(internals));
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
        path: "rocket/velocity_body/x",
        unit: "m/s",
        point_count: String(pointCount),
        t_min: 0,
        t_max: (pointCount - 1) / 30,
      },
      generate: (time) =>
        145 * Math.sin(time * 0.14) + 58 * Math.sin(time * 0.47) + time * 1.3,
    },
    {
      summary: {
        signal_id: "2",
        path: "rocket/velocity_body/y",
        unit: "m/s",
        point_count: String(pointCount),
        t_min: 0,
        t_max: (pointCount - 1) / 30,
      },
      generate: (time) =>
        54 * Math.cos(time * 0.19) + 26 * Math.sin(time * 0.63),
    },
  ];
  return seal({
    signals: demoSignals.map(({ summary, generate }) => ({
      summary,
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
