import { describe, expect, it } from "vitest";
import { binColumnsFromWire, type BinColumns } from "../app/bin-columns";
import type { ColumnarTileResponse } from "../app/bin-columns";
import {
  cachedFeed,
  m4Feed,
  prepareResponseFeeds,
  responseTimeReference,
} from "./m4-feed";

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

function points(feed: Float32Array): [number, number][] {
  const out: [number, number][] = [];
  for (let index = 0; index < feed.length; index += 2) {
    out.push([feed[index] as number, feed[index + 1] as number]);
  }
  return out;
}

describe("interleaved layout", () => {
  it("packs x and y as consecutive pairs with gaps preserved", () => {
    const feed = m4Feed(
      columns([
        { t0: 10, t1: 10, first: 2, min: 2, max: 2, last: 2 },
        { t0: 11, t1: 11, finiteCount: 0, gap: true },
        { t0: 12, t1: 12, first: 3, min: 3, max: 3, last: 3 },
      ]),
      10,
    );

    expect(feed).toBeInstanceOf(Float32Array);
    const pairs = points(feed);
    expect(pairs).toHaveLength(3);
    expect(pairs[0]).toEqual([0, 2]);
    expect(pairs[1]?.[0]).toBe(1);
    expect(pairs[1]?.[1]).toBeNaN();
    expect(pairs[2]).toEqual([2, 3]);
  });
});

describe("m4Feed", () => {
  it("emits one point for each singleton raw bin", () => {
    const feed = m4Feed(
      columns([
        { t0: 10, t1: 10, first: 2, min: 2, max: 2, last: 2 },
        { t0: 11, t1: 11, first: 3, min: 3, max: 3, last: 3 },
      ]),
      10,
    );
    expect(points(feed).map(([x]) => x)).toEqual([0, 1]);
    expect(points(feed).map(([, y]) => y)).toEqual([2, 3]);
  });

  it("allocates only the emitted capacity for singleton raw bins", () => {
    const feed = m4Feed(
      columns([
        { t0: 10, t1: 10, first: 2, min: 2, max: 2, last: 2 },
        { t0: 11, t1: 11, first: 3, min: 3, max: 3, last: 3 },
      ]),
      10,
    );

    expect(points(feed)).toHaveLength(2);
    expect(feed.buffer.byteLength).toBe(feed.byteLength);
  });

  it("emits one gap vertex for a missing singleton raw bin", () => {
    const feed = m4Feed(
      columns([{ t0: 10, t1: 10, gap: true, finiteCount: 0 }]),
      10,
    );
    expect(points(feed).map(([x]) => x)).toEqual([0]);
    expect(points(feed)[0]?.[1]).toBeNaN();
  });

  it("emits first, min, max, and last with midpoint extrema times", () => {
    const feed = m4Feed(
      columns([{ t0: 10, t1: 12, first: 1, min: 0, max: 5, last: 2 }]),
      10,
    );
    expect(points(feed).map(([x]) => x)).toEqual([0, 1, 1, 2]);
    expect(points(feed).map(([, y]) => y)).toEqual([1, 0, 5, 2]);
  });

  it("omits extrema already represented by endpoints", () => {
    const feed = m4Feed(
      columns([{ t0: 10, t1: 12, first: 1, min: 1, max: 5, last: 5 }]),
      10,
    );
    expect(points(feed)).toEqual([
      [0, 1],
      [2, 5],
    ]);
  });

  it("emits equal midpoint extrema once", () => {
    const feed = m4Feed(
      columns([{ t0: 0, t1: 2, first: 1, min: 0, max: 0, last: 1 }]),
      0,
    );
    expect(points(feed)).toEqual([
      [0, 1],
      [1, 0],
      [2, 1],
    ]);
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
    expect(
      points(feed)
        .map(([, y]) => y)
        .filter(Number.isNaN),
    ).toHaveLength(1);
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
    expect(points(feed).map(([, y]) => y)).toEqual([
      Number.NaN,
      1,
      0,
      5,
      2,
      Number.NaN,
    ]);
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

    expect(points(feed)).toHaveLength(9);
    expect(feed.buffer.byteLength).toBe(feed.byteLength);
    expect(points(feed).map(([, y]) => y)).toEqual([
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
    expect(points(feed).map(([x]) => x)).toEqual([1, 1]);
    expect(points(feed).map(([, y]) => y)).toEqual([0, 5]);
  });

  it("caches feeds by columns identity and reference time", () => {
    const left = columns([{ t0: 0, t1: 1, first: 1 }]);
    const right = columns([{ t0: 0, t1: 1, first: 1 }]);
    expect(cachedFeed(left, 0)).toBe(cachedFeed(left, 0));
    expect(cachedFeed(left, 0)).not.toBe(cachedFeed(right, 0));
    expect(cachedFeed(left, 1)).not.toBe(cachedFeed(left, 0));
  });

  it("prewarms the same feed ChartHost consumes", () => {
    const response: ColumnarTileResponse = {
      requestId: "prewarm",
      series: [
        {
          signalId: "7",
          signalPath: "run/value",
          unit: "V",
          level: 2,
          bins: columns([
            { t0: 10, t1: 12, first: 1, min: 0, max: 5, last: 2 },
          ]),
        },
      ],
    };
    prepareResponseFeeds(response);
    const reference = responseTimeReference(response);
    const first = response.series[0];
    if (first === undefined) throw new Error("missing response series");
    const prepared = cachedFeed(first.bins, reference);
    expect(prepared).toBe(cachedFeed(first.bins, reference));
  });
});
