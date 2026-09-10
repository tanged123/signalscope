import { expect, test } from "vitest";
import { createDirectedFeed, directedRange } from "./axis-direction";

test("reflection preserves row order and gaps while reusing immutable feeds", () => {
  const directedFeed = createDirectedFeed();
  const data = Float32Array.from([1, 2, 3, 4, NaN, NaN, 5, 6]);
  expect(directedFeed(data)).toBe(data);
  for (const [x, y] of [
    [true, false],
    [false, true],
    [true, true],
  ]) {
    const reflected = directedFeed(data, x, y);
    expect(reflected).toEqual(
      Float32Array.from([
        x ? -1 : 1,
        y ? -2 : 2,
        x ? -3 : 3,
        y ? -4 : 4,
        NaN,
        NaN,
        x ? -5 : 5,
        y ? -6 : 6,
      ]),
    );
    expect(directedFeed(data, x, y)).toBe(reflected);
  }
  expect(data[0]).toBe(1);
  expect(directedRange(1, 10, true)).toEqual({ min: -10, max: -1 });
  expect(directedRange(1, 10)).toEqual({ min: 1, max: 10 });
});

test("panels sharing a feed retain independent cached directions", () => {
  const first = createDirectedFeed();
  const second = createDirectedFeed();
  const data = Float32Array.from([1, 2, 3, 4]);
  const horizontal = first(data, true, false);
  const vertical = second(data, false, true);
  expect(first(data, true, false)).toBe(horizontal);
  expect(second(data, false, true)).toBe(vertical);
});
