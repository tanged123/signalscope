import type {
  BakedHistogram,
  EnvelopeBin,
  HistogramRequest,
  HistogramResponse,
  Line2DRequest,
  SampleRequest,
  SampleResponse,
  SignalSummary,
  SnapshotManifest,
  SourceSummary,
  TileRequest,
} from "../generated/protocol";
import { SESSION_SCHEMA_VERSION } from "../generated/session";
import { lowerBound, upperBound } from "./binary-search";
import {
  sliceColumns,
  type BinColumns,
  type ColumnarTileResponse,
} from "./bin-columns";
import type { DataPlane } from "./data-plane";
import type { Envelope } from "./envelope";
import {
  queryCapturedHistogram,
  validateHistogramCaptures,
} from "./histogram-data";
import type { Line2DResponse } from "./line-binary";
import { queryAdaptivePyramidRange } from "./pyramid-query";
import { columnsToSamples, sampleWindow, sampleWindowFull } from "./samples";
import {
  decodeSnapshot,
  levelFromBins,
  type BakedLineLevelData,
  type BakedSignalData,
  type BakedSnapshot,
} from "./snapshot-payload";

export class BakedPlane implements DataPlane {
  readonly histogramCaptures: readonly BakedHistogram[];
  readonly sourceLabel = "baked demo source";

  readonly ingest = null;

  readonly derived = null;
  readonly session = null;

  readonly restore = null;

  readonly preferences = null;

  readonly exporter = null;

  readonly bakedSessionJson: string;
  readonly bakedPreferencesJson?: string;

  private readonly signals: ReadonlyMap<string, BakedSignalData>;

  /**
   * Level-0 bins reconstructed as raw samples, per signal id. The mapping is
   * fixed for a baked payload, so it is built on first use rather than on
   * every windowed query.
   */
  private readonly rawSamples = new Map<
    string,
    { time: Float64Array; values: Float64Array }
  >();

  constructor(private readonly snapshot: BakedSnapshot) {
    this.histogramCaptures = validateHistogramCaptures(
      snapshot.histograms ?? undefined,
    );
    this.signals = new Map(
      snapshot.signals.map((signal) => [signal.summary.signal_id, signal]),
    );
    this.bakedSessionJson = snapshot.sessionJson;
    if (snapshot.preferencesJson != null) {
      this.bakedPreferencesJson = snapshot.preferencesJson;
    }
  }

  static async fromDocument(
    documentRoot: Document = document,
  ): Promise<BakedPlane> {
    const slot = documentRoot.querySelector<HTMLScriptElement>(
      "#signalscope-baked-data",
    );
    const value = slot === null ? null : slot.textContent.trim();
    if (value && value !== "null") {
      return new BakedPlane(
        await decodeSnapshot(JSON.parse(value) as Envelope<SnapshotManifest>),
      );
    }
    return new BakedPlane(createDemoSnapshot());
  }

  queryHistogram(
    request: HistogramRequest,
    signal?: AbortSignal,
  ): Promise<HistogramResponse> {
    return Promise.resolve().then(() => {
      signal?.throwIfAborted();
      return queryCapturedHistogram(this.histogramCaptures, request);
    });
  }

  listSignals(): Promise<SignalSummary[]> {
    return Promise.resolve(
      this.snapshot.signals.map((signal) => signal.summary),
    );
  }

  listSources(): Promise<SourceSummary[]> {
    const points = this.snapshot.signals.reduce(
      (total, signal) => total + Number(signal.summary.point_count),
      0,
    );
    return Promise.resolve([
      {
        source_id: "0",
        source_key: "00000000-0000-0000-0000-000000000000",
        prefix: this.snapshot.signals[0]?.summary.path.split("/")[0] ?? "demo",
        path: this.sourceLabel,
        point_count: String(points),
      },
    ]);
  }

  queryTiles(
    request: TileRequest,
    signal?: AbortSignal,
  ): Promise<ColumnarTileResponse> {
    return Promise.resolve().then(() => {
      signal?.throwIfAborted();
      return {
        requestId: request.request_id,
        series: request.signal_ids.map((signalId) => {
          const baked = this.signalFor(signalId);
          const range = queryAdaptivePyramidRange(
            baked.levels,
            request.window.t0,
            request.window.t1,
            request.pixel_width,
          );
          const level = baked.levels[range.level];
          const bins =
            level === undefined
              ? emptyColumns()
              : sliceColumns(level.columns(), range.start, range.end);
          return {
            signalId: baked.summary.signal_id,
            signalPath: baked.summary.path,
            unit: baked.summary.unit,
            level: range.level,
            bins,
          };
        }),
      };
    });
  }

  queryLine2D(
    request: Line2DRequest,
    signal?: AbortSignal,
  ): Promise<Line2DResponse> {
    return Promise.resolve().then(() => {
      signal?.throwIfAborted();
      const line = this.snapshot.line2d
        .filter(
          (candidate) =>
            candidate.x_signal_id === request.x_signal_id &&
            containsSignalSet(candidate.y_signal_ids, request.y_signal_ids),
        )
        .sort((a, b) => a.y_signal_ids.length - b.y_signal_ids.length)[0];
      if (line === undefined) {
        throw new Error(
          `no baked Line2D data for X ${request.x_signal_id} and Y ${request.y_signal_ids.join(",")}`,
        );
      }

      const xSummary = this.signals.get(line.x_signal_id)?.summary;
      if (xSummary === undefined) {
        throw new Error(`unknown baked X signal id: ${line.x_signal_id}`);
      }
      const ySummaries = request.y_signal_ids.map((signalId) => {
        const summary = this.signals.get(signalId)?.summary;
        if (summary === undefined) {
          throw new Error(`unknown baked Y signal id: ${signalId}`);
        }
        return summary;
      });
      const target = Math.max(1, Math.floor(request.pixel_width)) * 2;
      const selected = selectLineLevel(
        line.levels,
        request.window.t0,
        request.window.t1,
        target,
      );
      const range = lineRange(
        selected.anchor,
        request.window.t0,
        request.window.t1,
      );
      const bakedYIndices = new Map(
        line.y_signal_ids.map((signalId, index) => [signalId, index]),
      );
      const ys = ySummaries.map((summary) => {
        const bakedIndex = bakedYIndices.get(summary.signal_id);
        const values =
          bakedIndex === undefined ? undefined : selected.ys[bakedIndex];
        if (values === undefined) {
          throw new Error(`missing baked Y column: ${summary.signal_id}`);
        }
        return {
          signalId: summary.signal_id,
          signalPath: summary.path,
          unit: summary.unit,
          values: values.slice(range.start, range.end),
        };
      });
      return {
        requestId: request.request_id,
        level: selected.level,
        anchor: selected.anchor.slice(range.start, range.end),
        x: {
          signalId: xSummary.signal_id,
          signalPath: xSummary.path,
          unit: xSummary.unit,
          values: selected.x.slice(range.start, range.end),
        },
        ys,
      };
    });
  }

  querySamples(request: SampleRequest): Promise<SampleResponse> {
    return Promise.resolve().then(() => ({
      request_id: request.request_id,
      series: request.signal_ids.map((signalId) => {
        const baked = this.signalFor(signalId);
        const raw = this.rawFor(baked);
        const slice =
          request.max_points === 0
            ? sampleWindowFull(
                raw.time,
                raw.values,
                request.window.t0,
                request.window.t1,
              )
            : sampleWindow(
                raw.time,
                raw.values,
                request.window.t0,
                request.window.t1,
                request.max_points,
              );
        return {
          signal_id: baked.summary.signal_id,
          signal_path: baked.summary.path,
          unit: baked.summary.unit,
          time: slice.time,
          values: slice.values,
          stride: slice.stride,
        };
      }),
    }));
  }

  private signalFor(signalId: string): BakedSignalData {
    const signal = this.signals.get(signalId);
    if (signal === undefined) {
      throw new Error(`unknown signal id: ${signalId}`);
    }
    return signal;
  }

  /** ADR 0015: the finest baked level stands in for raw samples. */
  private rawFor(signal: BakedSignalData): {
    time: Float64Array;
    values: Float64Array;
  } {
    const id = signal.summary.signal_id;
    let raw = this.rawSamples.get(id);
    if (raw === undefined) {
      const level = signal.levels[0];
      raw =
        level === undefined
          ? { time: new Float64Array(), values: new Float64Array() }
          : columnsToSamples(level.columns());
      this.rawSamples.set(id, raw);
    }
    return raw;
  }
}

function emptyColumns(): BinColumns {
  return {
    count: 0,
    t0: new Float64Array(),
    t1: new Float64Array(),
    first: new Float64Array(),
    last: new Float64Array(),
    min: new Float64Array(),
    max: new Float64Array(),
    sum: new Float64Array(),
    sumSq: new Float64Array(),
    sampleCount: new Uint32Array(),
    finiteCount: new Uint32Array(),
    flags: new Uint8Array(),
  };
}

function containsSignalSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    right.every((id) => left.includes(id))
  );
}

function selectLineLevel(
  levels: readonly BakedLineLevelData[],
  t0: number,
  t1: number,
  target: number,
): BakedLineLevelData {
  const last = levels[levels.length - 1];
  if (last === undefined)
    throw new Error("baked Line2D combination has no levels");
  for (const level of levels) {
    const range = lineRange(level.anchor, t0, t1);
    if (range.end - range.start <= target) return level;
  }
  return last;
}
function lineRange(
  anchor: Float64Array,
  t0: number,
  t1: number,
): { start: number; end: number } {
  if (
    anchor.length === 0 ||
    t1 < (anchor[0] as number) ||
    t0 > (anchor[anchor.length - 1] as number)
  ) {
    return { start: 0, end: 0 };
  }
  const start = Math.max(0, lowerBound(anchor, t0) - 1);
  const end = Math.min(anchor.length, upperBound(anchor, t1) + 1);
  return { start, end };
}

function createDemoSnapshot(): BakedSnapshot {
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
  return {
    preferencesJson: null,
    sessionJson: JSON.stringify({
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
      levels: buildDemoLevels(makeBins(generate)).map(levelFromBins),
    })),
    line2d: [],
    histograms: null,
  };
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
