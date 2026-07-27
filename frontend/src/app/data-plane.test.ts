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
      path: "vehicle/speed",
      unit: "m/s",
      point_count: "5",
      t_min: 0,
      t_max: 4,
    };
    const plane = new BakedPlane(
      seal({
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
    const plane = new BakedPlane(seal({ signals: [] }));
    expect(plane.derived).toBeNull();
  });
});
