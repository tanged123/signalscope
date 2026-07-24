import {
  type EnvelopeBin,
  type SignalSummary,
  type TileRequest,
  type TileResponse,
} from "../generated/protocol";
import { open, seal, type Envelope } from "./envelope";
import { queryPyramid } from "./pyramid-query";

export interface DataPlane {
  readonly host: "native" | "snapshot";
  listSignals(): Promise<SignalSummary[]>;
  queryTiles(request: TileRequest): Promise<TileResponse>;
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
  readonly host = "native" as const;

  constructor(private readonly invoke: TauriInternals["invoke"]) {}

  async listSignals(): Promise<SignalSummary[]> {
    return open(await this.invoke<Envelope<SignalSummary[]>>("list_signals"));
  }

  async queryTiles(request: TileRequest): Promise<TileResponse> {
    return open(
      await this.invoke<Envelope<TileResponse>>("query_tiles", {
        request: seal(request),
      }),
    );
  }
}

export class BakedPlane implements DataPlane {
  readonly host = "snapshot" as const;

  private readonly payload: BakedManifest["payload"];

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
        sample_count: "1",
        has_gap: false,
      };
    });

  const summaries: SignalSummary[] = [
    {
      signal_id: "1",
      path: "rocket/velocity_body/x",
      unit: "m/s",
      point_count: String(pointCount),
    },
    {
      signal_id: "2",
      path: "rocket/velocity_body/y",
      unit: "m/s",
      point_count: String(pointCount),
    },
  ];
  const generators = [
    (time: number) =>
      145 * Math.sin(time * 0.14) + 58 * Math.sin(time * 0.47) + time * 1.3,
    (time: number) => 54 * Math.cos(time * 0.19) + 26 * Math.sin(time * 0.63),
  ];
  const fallbackGenerator = generators[0];
  if (fallbackGenerator === undefined) {
    throw new Error("Demo data requires at least one signal generator");
  }
  return seal({
    signals: summaries.map((summary, index) => ({
      summary,
      levels: buildDemoLevels(makeBins(generators[index] ?? fallbackGenerator)),
    })),
  });
}

function buildDemoLevels(levelZero: EnvelopeBin[]): EnvelopeBin[][] {
  const levels = [levelZero];
  while ((levels[levels.length - 1] as EnvelopeBin[]).length > 1) {
    const previous = levels[levels.length - 1] as EnvelopeBin[];
    const next: EnvelopeBin[] = [];
    for (let index = 0; index < previous.length; index += 2) {
      const left = previous[index] as EnvelopeBin;
      const right = previous[index + 1];
      next.push(right === undefined ? left : mergeDemoBins(left, right));
    }
    levels.push(next);
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
