/** Index of the first entry not less than `target` in a sorted array. */
export function lowerBound(values: ArrayLike<number>, target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((values[middle] as number) < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Index of the first entry greater than `target` in a sorted array. */
export function upperBound(values: ArrayLike<number>, target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((values[middle] as number) <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}
