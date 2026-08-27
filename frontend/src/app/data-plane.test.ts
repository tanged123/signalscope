import { describe, expect, it, vi } from "vitest";
import type { EnvelopeBin, SignalSummary } from "../generated/protocol";
import { BakedPlane, HttpPlane } from "./data-plane";
import { seal, type Envelope } from "./envelope";

function bin(time: number, value: number | null): EnvelopeBin {
  return {
    t0: time,
    t1: time,
    first: value,
    last: value,
    min: value,
    max: value,
    sum: value ?? 0,
    sum_sq: value === null ? 0 : value * value,
    finite_count: value === null ? "0" : "1",
    sample_count: "1",
    has_gap: value === null,
  };
}

function buildLevels(levelZero: EnvelopeBin[]): EnvelopeBin[][] {
  const levels = [levelZero];
  let current = levelZero;
  while (current.length > 1) {
    const next: EnvelopeBin[] = [];
    for (let index = 0; index < current.length; index += 2) {
      const left = current[index];
      const right = current[index + 1];
      if (left === undefined) continue;
      next.push(
        right === undefined
          ? left
          : {
              t0: left.t0,
              t1: right.t1,
              first: left.first,
              last: right.last,
              min: left.min ?? right.min,
              max: right.max ?? left.max,
              sum: left.sum + right.sum,
              sum_sq: left.sum_sq + right.sum_sq,
              finite_count: String(
                Number(left.finite_count) + Number(right.finite_count),
              ),
              sample_count: String(
                Number(left.sample_count) + Number(right.sample_count),
              ),
              has_gap: left.has_gap || right.has_gap,
            },
      );
    }
    levels.push(next);
    current = next;
  }
  return levels;
}

describe("BakedPlane.querySamples", () => {
  it("returns the full neighbour-inclusive level-zero slice with gaps intact", async () => {
    const summary: SignalSummary = {
      signal_id: "7",
      source_id: "3",
      source_key: "00000000-0000-0000-0000-000000000003",
      local_path: "speed",
      path: "vehicle/speed",
      unit: "m/s",
      point_count: "100",
      t_min: 0,
      t_max: 4,
      last_value: null,
    };
    const plane = new BakedPlane(
      seal({
        session_json: "",
        signals: [
          {
            summary,
            levels: [
              Array.from({ length: 100 }, (_, time) =>
                bin(time, time === 50 ? null : time),
              ),
            ],
          },
        ],
      }),
    );

    const response = await plane.querySamples({
      request_id: "samples-1",
      signal_ids: ["7"],
      window: { t0: 20, t1: 79 },
      max_points: 0,
    });

    expect(response.request_id).toBe("samples-1");
    expect(response.series[0]?.time).toHaveLength(62);
    expect(response.series[0]?.time[0]).toBe(19);
    expect(response.series[0]?.time[61]).toBe(80);
    expect(response.series[0]?.stride).toBe(1);
    expect(Number.isNaN(response.series[0]?.values[31])).toBe(true);
  });

  it("keeps positive max_points as an explicit export cap", async () => {
    const summary: SignalSummary = {
      signal_id: "7",
      source_id: "3",
      source_key: "00000000-0000-0000-0000-000000000003",
      local_path: "speed",
      path: "vehicle/speed",
      unit: "m/s",
      point_count: "100",
      t_min: 0,
      t_max: 99,
      last_value: null,
    };
    const plane = new BakedPlane(
      seal({
        session_json: "",
        signals: [
          {
            summary,
            levels: [Array.from({ length: 100 }, (_, time) => bin(time, time))],
          },
        ],
      }),
    );

    const response = await plane.querySamples({
      request_id: "samples-export-1",
      signal_ids: ["7"],
      window: { t0: 20, t1: 79 },
      max_points: 10,
    });

    expect(response.series[0]?.time).toEqual([
      19, 26, 33, 40, 47, 54, 61, 68, 75, 80,
    ]);
    expect(response.series[0]?.stride).toBe(7);
  });

  it("returns requested signals in request order", async () => {
    const summary = (signalId: string, path: string): SignalSummary => ({
      signal_id: signalId,
      source_id: "3",
      source_key: `00000000-0000-0000-0000-00000000000${signalId}`,
      local_path: path,
      path: `vehicle/${path}`,
      unit: "m/s",
      point_count: "3",
      t_min: 0,
      t_max: 2,
      last_value: null,
    });
    const plane = new BakedPlane(
      seal({
        session_json: "",
        signals: [
          {
            summary: summary("7", "speed"),
            levels: [Array.from({ length: 3 }, (_, time) => bin(time, time))],
          },
          {
            summary: summary("8", "rpm"),
            levels: [Array.from({ length: 3 }, (_, time) => bin(time, time))],
          },
        ],
      }),
    );

    const response = await plane.querySamples({
      request_id: "samples-order-1",
      signal_ids: ["8", "7"],
      window: { t0: 0, t1: 2 },
      max_points: 0,
    });

    expect(response.series.map((series) => series.signal_id)).toEqual([
      "8",
      "7",
    ]);
  });

  it("rejects unknown signal IDs", async () => {
    const summary: SignalSummary = {
      signal_id: "7",
      source_id: "3",
      source_key: "00000000-0000-0000-0000-000000000003",
      local_path: "speed",
      path: "vehicle/speed",
      unit: "m/s",
      point_count: "3",
      t_min: 0,
      t_max: 2,
      last_value: null,
    };
    const plane = new BakedPlane(
      seal({
        session_json: "",
        signals: [
          {
            summary,
            levels: [Array.from({ length: 3 }, (_, time) => bin(time, time))],
          },
        ],
      }),
    );

    await expect(
      plane.querySamples({
        request_id: "samples-unknown-1",
        signal_ids: ["missing"],
        window: { t0: 0, t1: 2 },
        max_points: 0,
      }),
    ).rejects.toThrow("unknown signal id: missing");
  });

  it("reports finite last values for both generated demo signals", async () => {
    const plane = BakedPlane.fromDocument({
      querySelector: () => null,
    } as unknown as Document);

    const signals = await plane.listSignals();

    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => Number.isFinite(signal.last_value))).toBe(
      true,
    );
  });
});

describe("BakedPlane.queryTiles", () => {
  it("selects adaptive overview and raw detail despite tile budgets", async () => {
    const summary: SignalSummary = {
      signal_id: "7",
      source_id: "3",
      source_key: "00000000-0000-0000-0000-000000000003",
      local_path: "speed",
      path: "vehicle/speed",
      unit: "m/s",
      point_count: "100",
      t_min: 0,
      t_max: 99,
      last_value: null,
    };
    const levelZero = Array.from({ length: 100 }, (_, time) => bin(time, time));
    const plane = new BakedPlane(
      seal({
        session_json: "",
        signals: [
          {
            summary,
            levels: buildLevels(levelZero),
          },
        ],
      }),
    );

    const overview = await plane.queryTiles({
      request_id: "tiles-1",
      signal_ids: ["7"],
      window: { t0: 0, t1: 99 },
      pixel_width: 20,
      max_total_bins: 1,
    });

    expect(overview.series[0]?.level).toBe(2);
    expect(overview.series[0]?.bins.count).toBe(25);

    const detail = await plane.queryTiles({
      request_id: "tiles-2",
      signal_ids: ["7"],
      window: { t0: 40, t1: 50 },
      pixel_width: 20,
      max_total_bins: 1,
    });

    expect(detail.series[0]?.level).toBe(0);
    expect(
      detail.series[0]?.bins.sampleCount.every((count) => count === 1),
    ).toBe(true);
  });

  it("returns requested signals in request order", async () => {
    const summary = (signalId: string, path: string): SignalSummary => ({
      signal_id: signalId,
      source_id: "3",
      source_key: `00000000-0000-0000-0000-00000000000${signalId}`,
      local_path: path,
      path: `vehicle/${path}`,
      unit: "m/s",
      point_count: "3",
      t_min: 0,
      t_max: 2,
      last_value: null,
    });
    const plane = new BakedPlane(
      seal({
        session_json: "",
        signals: [
          {
            summary: summary("7", "speed"),
            levels: [Array.from({ length: 3 }, (_, time) => bin(time, time))],
          },
          {
            summary: summary("8", "rpm"),
            levels: [Array.from({ length: 3 }, (_, time) => bin(time, time))],
          },
        ],
      }),
    );

    const response = await plane.queryTiles({
      request_id: "tiles-order-1",
      signal_ids: ["8", "7"],
      window: { t0: 0, t1: 2 },
      pixel_width: 10,
      max_total_bins: 10,
    });

    expect(response.series.map((series) => series.signalId)).toEqual([
      "8",
      "7",
    ]);
  });

  it("rejects unknown signal IDs", async () => {
    const summary: SignalSummary = {
      signal_id: "7",
      source_id: "3",
      source_key: "00000000-0000-0000-0000-000000000003",
      local_path: "speed",
      path: "vehicle/speed",
      unit: "m/s",
      point_count: "3",
      t_min: 0,
      t_max: 2,
      last_value: null,
    };
    const plane = new BakedPlane(
      seal({
        session_json: "",
        signals: [
          {
            summary,
            levels: [Array.from({ length: 3 }, (_, time) => bin(time, time))],
          },
        ],
      }),
    );

    await expect(
      plane.queryTiles({
        request_id: "tiles-unknown-1",
        signal_ids: ["missing"],
        window: { t0: 0, t1: 2 },
        pixel_width: 10,
        max_total_bins: 10,
      }),
    ).rejects.toThrow("unknown signal id: missing");
  });
});

function httpPlane(
  routes: Record<
    string,
    Envelope<unknown> | ((payload: unknown) => Envelope<unknown>)
  >,
) {
  const fetcher = vi.fn(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const inputUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const path = new URL(inputUrl, "http://localhost").pathname;
      const command = path.split("/").at(-1);
      if (command === undefined) throw new Error("missing API command");
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Envelope<unknown>)
          : undefined;
      const route = routes[command];
      if (route === undefined) {
        throw new Error("unexpected API command " + command);
      }
      const response =
        typeof route === "function" ? route(body?.payload) : route;
      return Promise.resolve(
        new Response(JSON.stringify(response), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    },
  );
  return { plane: new HttpPlane(fetcher as typeof fetch), fetcher };
}

describe("HttpPlane", () => {
  it("uses protocol envelopes and preserves wire identifiers as strings", async () => {
    const signals: SignalSummary[] = [
      {
        signal_id: "9007199254740993",
        source_id: "9007199254740995",
        source_key: "00000000-0000-0000-0000-000000000003",
        local_path: "speed",
        path: "vehicle/speed",
        unit: "m/s",
        point_count: "2",
        t_min: 0,
        t_max: 1,
        last_value: null,
      },
    ];
    const { plane, fetcher } = httpPlane({ list_signals: seal(signals) });

    const [signal] = await plane.listSignals();

    expect(typeof signal?.signal_id).toBe("string");
    expect(typeof signal?.source_id).toBe("string");
    expect(fetcher).toHaveBeenCalledWith(
      "/api/list_signals",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("starts a batch and reports aggregate progress", async () => {
    const { plane } = httpPlane({
      ingest_batch: seal({ job_id: "7" }),
      batch_status: seal({
        state: "running",
        fraction: 0,
        total: "2",
        done: "0",
        failed: "0",
        current_paths: [],
        recent_failures: [],
      }),
    });

    const jobId = await plane.ingest.startBatch(["/a.csv", "/b.csv"]);
    const status = await plane.ingest.batchStatus(jobId);

    expect(jobId).toBe("7");
    expect(status.total).toBe("2");
    expect(status.recent_failures).toEqual([]);
  });

  it("normalizes JSON null gap samples back to NaN", async () => {
    const { plane } = httpPlane({
      query_samples: seal({
        request_id: "samples-2",
        series: [
          {
            signal_id: "7",
            signal_path: "vehicle/speed",
            unit: "m/s",
            time: [0, 1, 2],
            values: [0, null, 2],
            stride: 1,
          },
        ],
      }),
    });

    const response = await plane.querySamples({
      request_id: "samples-2",
      signal_ids: ["7"],
      window: { t0: 0, t1: 2 },
      max_points: 64,
    });

    expect(Number.isNaN(response.series[0]?.values[1])).toBe(true);
  });

  it("routes restore, derived, session, preferences, and export calls over HTTP", async () => {
    const { plane } = httpPlane({
      restore_sources: seal({ job_id: "9" }),
      restore_reconcile: seal({
        session_json: "{}",
        rewritten: "2",
        conflicts: [],
        unresolved: [],
      }),
      create_derived: seal({
        signal_id: "7",
        source_id: "3",
        source_key: "00000000-0000-0000-0000-000000000003",
        local_path: "speed",
        path: "derived/speed",
        unit: null,
        point_count: "3",
        t_min: 0,
        t_max: 2,
        last_value: null,
      }),
      reset_session: seal({ session_json: "{}", path: null }),
      load_preferences: seal(null),
      export_estimate: seal({ entries: [] }),
    });

    expect(await plane.restore.start("{}")).toBe("9");
    expect((await plane.restore.reconcile("{}", "9")).rewritten).toBe("2");
    expect((await plane.derived.create("derived/speed", "1")).path).toBe(
      "derived/speed",
    );
    expect((await plane.session.reset()).path).toBeNull();
    expect(await plane.preferences.load()).toBeNull();
    expect(
      (await plane.exporter.estimate("{}", { source_keys: [] })).entries,
    ).toEqual([]);
  });

  it("rejects an invalid protocol version", async () => {
    const { plane } = httpPlane({
      list_sources: { protocol_version: 999, payload: [] },
    });

    await expect(plane.listSources()).rejects.toThrow(
      "Unsupported protocol version",
    );
  });
});

describe("snapshot capabilities", () => {
  it("does not expose native-only ports", () => {
    const plane = new BakedPlane(
      seal({
        session_json: '{"app":"signalscope"}',
        signals: [],
      }),
    );

    expect(plane.derived).toBeNull();
    expect(plane.exporter).toBeNull();
    expect(plane.bakedSessionJson).toBe('{"app":"signalscope"}');
  });
});
