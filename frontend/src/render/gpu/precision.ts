export function splitF64(value: number): readonly [high: number, low: number] {
  const high = Math.fround(value);
  return [high, Math.fround(value - high)];
}

export function projectEpoch(
  time: number,
  viewOrigin: number,
  pixelsPerUnit: number,
  devicePixelRatio: number,
): number {
  const [relativeHigh, relativeLow] = splitF64(time - viewOrigin);
  const relative = Math.fround(relativeHigh + relativeLow);
  return Math.fround(relative * pixelsPerUnit * devicePixelRatio);
}
