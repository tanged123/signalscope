import { expect, test } from "vitest";
import type { EnvelopeBin } from "../generated/protocol";
import { binColumnsFromWire } from "./bin-columns";
import type { BinColumns } from "./bin-columns";
import { projectX, projectY, type PlotLayout } from "./plot-math";
import { nearestLine, nearestVertex } from "./plot-hit";

const layout: PlotLayout = {
  plot: { x: 0, y: 0, width: 100, height: 100 },
  xRange: { min: 0, max: 10 },
  yRange: { min: 0, max: 10 },
};

function bin(t0: number, t1: number, first: number, last: number): EnvelopeBin {
  return {
    t0,
    t1,
    first,
    last,
    min: Math.min(first, last),
    max: Math.max(first, last),
    sum: first + last,
    sum_sq: first * first + last * last,
    finite_count: "2",
    sample_count: "2",
    has_gap: false,
  };
}

test("nearestVertex snaps globally within its threshold", () => {
  const hit = nearestVertex(
    [
      {
        path: "a/b",
        bins: binColumnsFromWire([bin(0, 1, 5, 6), bin(1, 2, 6, 2)]),
      },
    ],
    layout,
    22,
    78,
    14,
  );
  expect(hit).toMatchObject({ path: "a/b", time: 2, value: 2 });
  expect(nearestVertex([], layout, 20, 80, 14)).toBeNull();
});

test("returns the same vertex from padded columns as from trimmed columns", () => {
  const layout: PlotLayout = {
    plot: { x: 0, y: 0, width: 100, height: 100 },
    xRange: { min: 10, max: 20 },
    yRange: { min: 0, max: 10 },
  };
  const binAt = (t: number, value: number): EnvelopeBin => ({
    t0: t,
    t1: t,
    first: value,
    last: value,
    min: value,
    max: value,
    sum: value,
    sum_sq: value * value,
    finite_count: "1",
    sample_count: "1",
    has_gap: false,
  });
  const padded: EnvelopeBin[] = [];
  for (let t = 0; t <= 30; t += 1) padded.push(binAt(t, t % 10));
  const trimmed = padded.filter((entry) => entry.t0 >= 10 && entry.t0 <= 20);
  let paddedReads = 0;
  const columns = binColumnsFromWire(padded);
  const counted = (values: Float64Array): Float64Array =>
    new Proxy(values, {
      get(target, property) {
        if (typeof property === "string" && /^\d+$/.test(property)) {
          paddedReads += 1;
        }
        return Reflect.get(target, property, target);
      },
    });
  const countedColumns = {
    ...columns,
    t0: counted(columns.t0),
    t1: counted(columns.t1),
    first: counted(columns.first),
    last: counted(columns.last),
    flags: new Proxy(columns.flags, {
      get(target, property) {
        if (typeof property === "string" && /^\d+$/.test(property)) {
          paddedReads += 1;
        }
        return Reflect.get(target, property, target);
      },
    }),
  } as BinColumns;

  const at = (bins: EnvelopeBin[]) =>
    nearestVertex(
      [{ path: "a", bins: binColumnsFromWire(bins) }],
      layout,
      projectX(layout, 15),
      projectY(layout, 5),
      6,
    );

  expect(at(padded)).toEqual(at(trimmed));
  expect(at(padded)?.time).toBe(15);
  nearestVertex(
    [{ path: "a", bins: countedColumns }],
    layout,
    projectX(layout, 15),
    projectY(layout, 5),
    6,
  );
  expect(paddedReads).toBeLessThan(padded.length * 5);
});

test("nearestLine hits the rendered envelope within a pixel tolerance", () => {
  const hit = nearestLine(
    [{ path: "a/b", bins: binColumnsFromWire([bin(4, 6, 5, 7)]) }],
    layout,
    51,
    45,
    6,
  );
  expect(hit?.path).toBe("a/b");
  expect(hit?.distance).toBe(1);
  expect(nearestLine([], layout, 50, 50, 6)).toBeNull();
});

test("nearestLine does not connect bins across a gap", () => {
  const first = { ...bin(0, 1, 2, 2), has_gap: true };
  const second = bin(9, 10, 8, 8);

  expect(
    nearestLine(
      [{ path: "a/b", bins: binColumnsFromWire([first, second]) }],
      layout,
      50,
      50,
      8,
    ),
  ).toBeNull();
});
