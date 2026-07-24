import {
  PROTOCOL_VERSION,
  type EnvelopeBin,
  type SignalSummary,
  type TileRequest,
  type TileResponse,
} from "../generated/protocol";

export interface DataPlane {
  readonly host: "native" | "snapshot";
  listSignals(): Promise<SignalSummary[]>;
  queryTiles(request: TileRequest): Promise<TileResponse>;
}

interface BakedManifest {
  protocol_version: number;
  signals: SignalSummary[];
  tiles: TileResponse;
}

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

  listSignals(): Promise<SignalSummary[]> {
    return this.invoke<SignalSummary[]>("list_signals");
  }

  queryTiles(request: TileRequest): Promise<TileResponse> {
    return this.invoke<TileResponse>("query_tiles", { request });
  }
}

export class BakedPlane implements DataPlane {
  readonly host = "snapshot" as const;

  constructor(private readonly manifest: BakedManifest) {
    if (manifest.protocol_version !== PROTOCOL_VERSION) {
      throw new Error(
        `Snapshot protocol ${String(manifest.protocol_version)} is unsupported; expected ${String(PROTOCOL_VERSION)}`,
      );
    }
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
    return Promise.resolve(this.manifest.signals);
  }

  queryTiles(request: TileRequest): Promise<TileResponse> {
    const requested = new Set(request.signal_ids);
    return Promise.resolve({
      protocol_version: PROTOCOL_VERSION,
      request_id: request.request_id,
      series: this.manifest.tiles.series
        .filter((series) => requested.has(series.signal_id))
        .map((series) => ({
          ...series,
          bins: series.bins.filter(
            (bin) => bin.t1 >= request.window.t0 && bin.t0 <= request.window.t1,
          ),
        })),
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

  const signals: SignalSummary[] = [
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
  return {
    protocol_version: PROTOCOL_VERSION,
    signals,
    tiles: {
      protocol_version: PROTOCOL_VERSION,
      request_id: "baked-demo",
      series: [
        {
          signal_id: "1",
          signal_path: signals[0]?.path ?? "signal/x",
          unit: "m/s",
          level: 0,
          bins: makeBins(
            (time) =>
              145 * Math.sin(time * 0.14) +
              58 * Math.sin(time * 0.47) +
              time * 1.3,
          ),
        },
        {
          signal_id: "2",
          signal_path: signals[1]?.path ?? "signal/y",
          unit: "m/s",
          level: 0,
          bins: makeBins(
            (time) => 54 * Math.cos(time * 0.19) + 26 * Math.sin(time * 0.63),
          ),
        },
      ],
    },
  };
}
