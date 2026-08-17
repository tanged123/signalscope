import { describe, expect, it } from "vitest";
import { binColumnsFromWire, type BinColumns } from "../app/bin-columns";
import { cachedFeed, m4Feed } from "./m4-feed";

function columns(
  values: {
    t0: number;
    t1: number;
    first?: number;
    last?: number;
    min?: number;
    max?: number;
    gap?: boolean;
    finiteCount?: number;
  }[],
): BinColumns {
  return binColumnsFromWire(
    values.map((value) => ({
      t0: value.t0,
      t1: value.t1,
      first: value.first ?? null,
      last: value.last ?? null,
      min: value.min ?? null,
      max: value.max ?? null,
      sum: value.first ?? 0,
      sum_sq: 0,
      finite_count: String(value.finiteCount ?? (value.gap ? 0 : 1)),
      sample_count: "1",
      has_gap: value.gap ?? false,
    })),
  );
}

describe("m4Feed", () => {
  it("emits one point for each singleton raw bin", () => {
    const feed = m4Feed(
      columns([
        { t0: 10, t1: 10, first: 2, min: 2, max: 2, last: 2 },
        { t0: 11, t1: 11, first: 3, min: 3, max: 3, last: 3 },
      ]),
      10,
    );
    expect([...feed.x]).toEqual([0, 1]);
    expect([...feed.y]).toEqual([2, 3]);
  });

  it("allocates only the emitted capacity for singleton raw bins", () => {
    const feed = m4Feed(
      columns([
        { t0: 10, t1: 10, first: 2, min: 2, max: 2, last: 2 },
        { t0: 11, t1: 11, first: 3, min: 3, max: 3, last: 3 },
      ]),
      10,
    );

    expect(feed.x).toHaveLength(2);
    expect(feed.x.buffer.byteLength).toBe(feed.x.byteLength);
    expect(feed.y.buffer.byteLength).toBe(feed.y.byteLength);
  });

  it("emits one gap vertex for a missing singleton raw bin", () => {
    const feed = m4Feed(
      columns([{ t0: 10, t1: 10, gap: true, finiteCount: 0 }]),
      10,
    );
    expect([...feed.x]).toEqual([0]);
    expect(Number.isNaN(feed.y[0])).toBe(true);
  });

  it("emits first, min, max, and last with midpoint extrema times", () => {
    const feed = m4Feed(
      columns([{ t0: 10, t1: 12, first: 1, min: 0, max: 5, last: 2 }]),
      10,
    );
    expect([...feed.x]).toEqual([0, 1, 1, 2]);
    expect([...feed.y]).toEqual([1, 0, 5, 2]);
  });

  it("breaks the polyline at a gap bin", () => {
    const feed = m4Feed(
      columns([
        { t0: 0, t1: 1, first: 1, min: 1, max: 1, last: 1 },
        { t0: 2, t1: 3, gap: true },
        { t0: 4, t1: 5, first: 2, min: 2, max: 2, last: 2 },
      ]),
      0,
    );
    expect([...feed.y].filter(Number.isNaN)).toHaveLength(1);
  });

  it("breaks before and after finite extrema in a gapped bin", () => {
    const feed = m4Feed(
      columns([
        {
          t0: 0,
          t1: 2,
          first: 1,
          min: 0,
          max: 5,
          last: 2,
          gap: true,
          finiteCount: 4,
        },
      ]),
      0,
    );
    expect([...feed.y]).toEqual([Number.NaN, 1, 0, 5, 2, Number.NaN]);
  });

  it("allocates aggregate extrema and gap vertices exactly", () => {
    const feed = m4Feed(
      columns([
        {
          t0: 0,
          t1: 2,
          first: 1,
          min: 0,
          max: 5,
          last: 2,
          gap: true,
          finiteCount: 4,
        },
        { t0: 3, t1: 5, min: 3, max: 4 },
        { t0: 6, t1: 7, gap: true, finiteCount: 0 },
      ]),
      0,
    );

    expect(feed.x).toHaveLength(9);
    expect(feed.x.buffer.byteLength).toBe(feed.x.byteLength);
    expect(feed.y.buffer.byteLength).toBe(feed.y.byteLength);
    expect([...feed.y]).toEqual([
      Number.NaN,
      1,
      0,
      5,
      2,
      Number.NaN,
      3,
      4,
      Number.NaN,
    ]);
  });

  it("skips vertices whose flag is absent", () => {
    const feed = m4Feed(columns([{ t0: 10, t1: 12, min: 0, max: 5 }]), 10);
    expect([...feed.x]).toEqual([1, 1]);
    expect([...feed.y]).toEqual([0, 5]);
  });

  it("caches feeds by columns identity and reference time", () => {
    const left = columns([{ t0: 0, t1: 1, first: 1 }]);
    const right = columns([{ t0: 0, t1: 1, first: 1 }]);
    expect(cachedFeed(left, 0)).toBe(cachedFeed(left, 0));
    expect(cachedFeed(left, 0)).not.toBe(cachedFeed(right, 0));
    expect(cachedFeed(left, 1)).not.toBe(cachedFeed(left, 0));
  });
});
