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

describe("BakedPlane.querySamples", () => {
  it("returns a capped level-zero slice with gaps intact", async () => {
    const summary: SignalSummary = {
      signal_id: "7",
      source_id: "3",
      source_key: "00000000-0000-0000-0000-000000000003",
      local_path: "speed",
      path: "vehicle/speed",
      unit: "m/s",
      point_count: "5",
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
              [bin(0, 0), bin(1, 1), bin(2, null), bin(3, 3), bin(4, 4)],
            ],
          },
        ],
      }),
    );

    const response = await plane.querySamples({
      request_id: "samples-1",
      signal_ids: ["7"],
      window: { t0: 1, t1: 3 },
      max_points: 3,
    });

    expect(response.request_id).toBe("samples-1");
    expect(response.series[0]?.time).toEqual([0, 2, 4]);
    expect(response.series[0]?.stride).toBe(2);
    expect(Number.isNaN(response.series[0]?.values[1])).toBe(true);
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
