import { describe, expect, it } from "vitest";
import type {
  BakedLevel,
  EnvelopeBin,
  SignalSummary,
} from "../generated/protocol";
import { BakedPlane } from "./data-plane";
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
  it("uses the finest baked ordered points for samples", async () => {
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
              {
                level: 0,
                source_start: "0",
                source_end: "5",
                origin: 0,
                bins: [
                  bin(0, 0),
                  bin(1, 1),
                  bin(2, null),
                  bin(3, 3),
                  bin(4, 4),
                ],
                points: [
                  {
                    time: 0,
                    value: 0,
                    source_index: "0",
                    break_before: false,
                  },
                  {
                    time: 1,
                    value: 1,
                    source_index: "1",
                    break_before: false,
                  },
                  {
                    time: 3,
                    value: 3,
                    source_index: "3",
                    break_before: true,
                  },
                  {
                    time: 4,
                    value: 4,
                    source_index: "4",
                    break_before: false,
                  },
                ],
              } satisfies BakedLevel,
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
    expect(response.series[0]?.time).toEqual([0, 3, 4]);
    expect(response.series[0]?.stride).toBe(2);
    expect(response.series[0]?.values).toEqual([0, 3, 4]);
  });

  it("returns packed partial tile metadata from the same ordered points", async () => {
    const summary: SignalSummary = {
      signal_id: "7",
      source_id: "3",
      source_key: "00000000-0000-0000-0000-000000000003",
      local_path: "speed",
      path: "vehicle/speed",
      unit: "m/s",
      point_count: "4",
      t_min: 100,
      t_max: 103,
      last_value: 4,
    };
    const plane = new BakedPlane(
      seal({
        session_json: "",
        signals: [
          {
            summary,
            levels: [
              {
                level: 0,
                source_start: "10",
                source_end: "14",
                origin: 100,
                bins: [100, 101, 102, 103].map(bin),
                points: [
                  {
                    time: 100,
                    value: 1,
                    source_index: "10",
                    break_before: false,
                  },
                  {
                    time: 101,
                    value: 2,
                    source_index: "11",
                    break_before: false,
                  },
                  {
                    time: 102,
                    value: 3,
                    source_index: "12",
                    break_before: true,
                  },
                  {
                    time: 103,
                    value: 4,
                    source_index: "13",
                    break_before: false,
                  },
                ],
              } satisfies BakedLevel,
            ],
          },
        ],
      }),
    );

    const response = await plane.queryTiles({
      request_id: "tiles-1",
      signal_ids: ["7"],
      window: { t0: 101.5, t1: 102.5 },
      pixel_width: 100,
    });
    const tile = response.series[0];
    expect(tile?.sourceStart).toBe("11");
    expect(tile?.sourceEnd).toBe("14");
    expect(tile?.origin).toBe(101);
    expect(tile?.points.count).toBe(3);
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
