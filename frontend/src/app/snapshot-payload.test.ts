import { describe, expect, it } from "vitest";
import fixtureJson from "../../../protocol/testdata/snapshot-payload-conformance.json";
import type { EnvelopeBin, SnapshotManifest } from "../generated/protocol";
import { BakedPlane } from "./baked-plane";
import { binColumnsFromWire, type BinColumns } from "./bin-columns";
import type { Envelope } from "./envelope";
import { decodeSnapshot } from "./snapshot-payload";
import { snapshotFromWire } from "./wire-snapshot";

interface Fixture {
  snapshot: Envelope<SnapshotManifest>;
  levels: EnvelopeBin[][];
  line_x: (number | null)[];
  line_y: (number | null)[];
}

const fixture = fixtureJson as unknown as Fixture;

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`missing index ${String(index)}`);
  return value;
}

function plain(columns: BinColumns): Record<string, number[]> {
  return Object.fromEntries(
    Object.entries(columns)
      .filter(([key]) => key !== "count")
      .map(([key, value]) => [key, Array.from(value as ArrayLike<number>)]),
  );
}

describe("decodeSnapshot", () => {
  it("decodes Rust-encoded levels to the same bins as the JSON wire", async () => {
    const snapshot = await decodeSnapshot(fixture.snapshot);
    const levels = snapshot.signals[0]?.levels ?? [];
    expect(levels).toHaveLength(fixture.levels.length);
    levels.forEach((level, index) => {
      const expected = binColumnsFromWire(fixture.levels[index] ?? []);
      expect(level.count).toBe(expected.count);
      expect(plain(level.columns())).toEqual(plain(expected));
    });
  });

  it("decodes Line2D columns with missing values as NaN", async () => {
    const snapshot = await decodeSnapshot(fixture.snapshot);
    const level = snapshot.line2d[0]?.levels[0];
    const nan = (values: (number | null)[]) =>
      values.map((value) => value ?? Number.NaN);
    expect(Array.from(level?.x ?? [])).toEqual(nan(fixture.line_x));
    expect(Array.from(level?.ys[0] ?? [])).toEqual(nan(fixture.line_y));
  });

  it("serves the same tiles and samples as wire-built levels", async () => {
    const decoded = new BakedPlane(await decodeSnapshot(fixture.snapshot));
    const wire = new BakedPlane(
      snapshotFromWire({
        session_json: "{}",
        signals: [
          {
            summary: at(fixture.snapshot.payload.signals, 0).summary,
            levels: fixture.levels,
          },
        ],
      }),
    );
    for (const [t0, t1, pixel_width] of [
      [0, 10, 400],
      [0, 10, 4],
      [1, 3, 8],
    ] as const) {
      const request = {
        request_id: "r",
        signal_ids: ["1"],
        window: { t0, t1 },
        pixel_width,
      };
      const [left, right] = await Promise.all([
        decoded.queryTiles(request),
        wire.queryTiles(request),
      ]);
      expect(left.series[0]?.level).toBe(right.series[0]?.level);
      expect(plain(at(left.series, 0).bins)).toEqual(
        plain(at(right.series, 0).bins),
      );
    }
    const samples = {
      request_id: "s",
      signal_ids: ["1"],
      window: { t0: 1, t1: 6 },
      max_points: 0,
    };
    expect(await decoded.querySamples(samples)).toEqual(
      await wire.querySamples(samples),
    );
  });

  it.each([
    [
      "an unsupported protocol version",
      (envelope: Envelope<SnapshotManifest>) => {
        envelope.protocol_version = 19;
      },
      "Unsupported protocol version",
    ],
    [
      "a sample level that points at a bin count column",
      (envelope: Envelope<SnapshotManifest>) => {
        const levels = at(envelope.payload.signals, 0).levels;
        at(levels, 0).columns[0] = at(at(levels, 1).columns, 8);
      },
      "not f64",
    ],
    [
      "a missing column reference",
      (envelope: Envelope<SnapshotManifest>) => {
        at(at(envelope.payload.signals, 0).levels, 0).columns[0] = 9_999;
      },
      "missing",
    ],
    [
      "a damaged payload",
      (envelope: Envelope<SnapshotManifest>) => {
        envelope.payload.payload = envelope.payload.payload.slice(0, 40);
      },
      "Invalid snapshot payload",
    ],
  ])("rejects %s", async (_name, damage, message) => {
    const envelope = structuredClone(fixture.snapshot);
    damage(envelope);
    await expect(decodeSnapshot(envelope)).rejects.toThrow(message);
  });
});
