import { describe, expect, it } from "vitest";
import type { EnvelopeBin, SignalSummary } from "../generated/protocol";
import { BakedPlane, TauriPlane } from "./data-plane";
import { seal } from "./envelope";

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
});

describe("BakedPlane.listSets", () => {
  it("derives bundle paths from baked signals and session membership", async () => {
    const session = {
      app: "signalscope",
      schema_version: 14,
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
      favorites: [],
      derived: [],
      sources: [],
      source_sets: [
        {
          key: "set-key-1",
          label: "Runs",
          generation: "1",
          time_domain: {
            unit: "seconds",
            origin: "relative",
            alignment_origin: 0,
          },
          members: [
            { source_key: "k1", missing: [], scale: 1, offset: 0 },
            { source_key: "k2", missing: [], scale: 1, offset: 0 },
          ],
        },
      ],
    };
    const summary = (
      signal_id: string,
      source_key: string,
      local_path: string,
    ) => ({
      signal_id,
      source_id: signal_id,
      source_key,
      local_path,
      path: `${source_key}/${local_path}`,
      unit: null,
      point_count: "1",
      t_min: 0,
      t_max: 0,
    });
    const plane = new BakedPlane(
      seal({
        session_json: JSON.stringify(session),
        signals: [
          { summary: summary("1", "k1", "alt"), levels: [[bin(0, 1)]] },
          { summary: summary("2", "k2", "alt"), levels: [[bin(0, 2)]] },
          { summary: summary("3", "k1", "solo"), levels: [[bin(0, 3)]] },
        ],
      }),
    );

    const sets = await plane.listSets();
    expect(sets).toHaveLength(1);
    expect(sets[0]?.set_key).toBe("set-key-1");
    expect(sets[0]?.member_count).toBe(2);
    expect(sets[0]?.local_paths).toEqual(["alt"]);
    expect(sets[0]?.members.map((member) => member.source_key)).toEqual([
      "k1",
      "k2",
    ]);
  });
});

describe("batch ingest port", () => {
  it("keeps wire identity fields as strings", async () => {
    const plane = new TauriPlane(() =>
      Promise.resolve(
        seal([
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
          },
        ]) as never,
      ),
    );

    const [signal] = await plane.listSignals();
    expect(typeof signal?.signal_id).toBe("string");
    expect(typeof signal?.source_id).toBe("string");
    expect(signal?.source_key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("starts a batch and reports aggregate progress", async () => {
    const plane = new TauriPlane((command) => {
      if (command === "ingest_batch") {
        return Promise.resolve(seal({ job_id: "7" }) as never);
      }
      return Promise.resolve(
        seal({
          state: "running",
          fraction: 0,
          total: "2",
          done: "0",
          failed: "0",
          current_paths: [],
          recent_failures: [],
        }) as never,
      );
    });

    const jobId = await plane.ingest.startBatch(["/a.csv", "/b.csv"]);
    const status = await plane.ingest.batchStatus(jobId);
    expect(status.total).toBe("2");
    expect(status.recent_failures).toEqual([]);
  });
});

describe("restore port", () => {
  it("submits and reconciles one restore batch", async () => {
    const calls: { command: string; args?: Record<string, unknown> }[] = [];
    const plane = new TauriPlane((command, args) => {
      calls.push({ command, ...(args === undefined ? {} : { args }) });
      return Promise.resolve(
        command === "restore_sources"
          ? (seal({ job_id: "9" }) as never)
          : (seal({
              session_json: "{}",
              rewritten: "2",
              conflicts: [],
              unresolved: [],
            }) as never),
      );
    });

    const jobId = await plane.restore.start("{}");
    const response = await plane.restore.reconcile("{}", jobId);
    expect(response.rewritten).toBe("2");
    expect(calls.map((call) => call.command)).toEqual([
      "restore_sources",
      "restore_reconcile",
    ]);
  });
});

describe("TauriPlane.querySamples", () => {
  it("normalizes JSON null gap samples back to NaN", async () => {
    const invoke = <T>(): Promise<T> =>
      Promise.resolve(
        JSON.parse(
          JSON.stringify(
            seal({
              request_id: "samples-2",
              series: [
                {
                  signal_id: "7",
                  signal_path: "vehicle/speed",
                  unit: "m/s",
                  time: [0, 1, 2],
                  values: [0, Number.NaN, 2],
                  stride: 1,
                },
              ],
            }),
          ),
        ) as T,
      );
    const response = await new TauriPlane(invoke).querySamples({
      request_id: "samples-2",
      signal_ids: ["7"],
      window: { t0: 0, t1: 2 },
      max_points: 64,
    });

    expect(Number.isNaN(response.series[0]?.values[1])).toBe(true);
  });
});

describe("derived port", () => {
  it("creates a derived signal through the native plane", async () => {
    const calls: { command: string; args?: Record<string, unknown> }[] = [];
    const plane = new TauriPlane((command, args) => {
      calls.push({ command, ...(args === undefined ? {} : { args }) });
      return Promise.resolve(
        seal({
          signal_id: "7",
          path: "derived/speed",
          unit: null,
          point_count: "3",
          t_min: 0,
          t_max: 2,
        }) as never,
      );
    });
    const summary = await plane.derived.create("derived/speed", "'a/x' * 2");
    expect(summary.path).toBe("derived/speed");
    expect(calls[0]?.command).toBe("create_derived");
  });

  it("removes a derived signal through the native plane", async () => {
    const calls: { command: string; args?: Record<string, unknown> }[] = [];
    const plane = new TauriPlane((command, args) => {
      calls.push({ command, ...(args === undefined ? {} : { args }) });
      return Promise.resolve(seal(null) as never);
    });
    await plane.derived.remove("derived/speed");
    expect(calls[0]?.command).toBe("remove_signal");
  });

  it("has no derived port in a snapshot", () => {
    const plane = new BakedPlane(seal({ session_json: "", signals: [] }));
    expect(plane.derived).toBeNull();
  });
});

describe("session port", () => {
  it("starts a new native session through the native plane", async () => {
    const calls: string[] = [];
    const plane = new TauriPlane((command) => {
      calls.push(command);
      return Promise.resolve(
        seal({
          session_json: '{"app":"signalscope"}',
          path: null,
        }) as never,
      );
    });

    const loaded = await plane.session.reset();

    expect(calls).toEqual(["reset_session"]);
    expect(loaded.path).toBeNull();
  });
});

describe("export port", () => {
  it("routes export calls through native commands", async () => {
    const calls: { command: string; args?: Record<string, unknown> }[] = [];
    const plane = new TauriPlane((command, args) => {
      calls.push({ command, ...(args === undefined ? {} : { args }) });
      if (command === "export_estimate") {
        return Promise.resolve(
          seal({
            entries: [
              {
                range: "visible",
                fidelity: "standard",
                bytes: "10",
                series_total: "1",
                series_decimated: "1",
                series_full_rate: "0",
                coarsest_ratio: "4",
              },
            ],
          }) as never,
        );
      }
      return Promise.resolve(seal("/tmp/out.html") as never);
    });

    const selection = { source_keys: ["source"], set_keys: ["set"] };
    const estimate = await plane.exporter.estimate("{}", selection);
    expect(estimate.entries[0]?.bytes).toBe("10");
    await plane.exporter.writeHtml("{}", "visible", "standard", selection);
    expect(calls.map((call) => call.command)).toEqual([
      "export_estimate",
      "export_write",
    ]);
    expect(calls[1]?.args?.request).toEqual(
      seal({
        session_json: "{}",
        range: "visible",
        fidelity: "standard",
        selection,
      }),
    );
  });

  it("selects one export folder and writes named files into it", async () => {
    const calls: { command: string; args?: Record<string, unknown> }[] = [];
    const plane = new TauriPlane((command, args) => {
      calls.push({ command, ...(args === undefined ? {} : { args }) });
      return Promise.resolve(
        seal(
          command === "pick_export_directory"
            ? "/tmp/exports"
            : "/tmp/exports/plot.png",
        ) as never,
      );
    });

    expect(await plane.exporter.pickDirectory()).toBe("/tmp/exports");
    expect(
      await plane.exporter.saveFileToDirectory(
        "/tmp/exports",
        "plot.png",
        "png",
        "cG5n",
      ),
    ).toBe("/tmp/exports/plot.png");
    expect(calls.map((call) => call.command)).toEqual([
      "pick_export_directory",
      "save_export_file_to_directory",
    ]);
    expect(calls[1]?.args?.request).toEqual(
      seal({
        directory: "/tmp/exports",
        file_name: "plot.png",
        kind: "png",
        data_base64: "cG5n",
      }),
    );
  });

  it("exposes the baked session and no exporter", () => {
    const plane = new BakedPlane(
      seal({
        session_json: '{"app":"signalscope"}',
        signals: [],
      }),
    );
    expect(plane.bakedSessionJson).toBe('{"app":"signalscope"}');
    expect(plane.exporter).toBeNull();
  });
});
