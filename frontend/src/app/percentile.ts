export function percentile(
  sortedValues: readonly number[],
  fraction: number,
): number {
  if (sortedValues.length === 0) return 0;
  const rank = Math.min(
    sortedValues.length,
    Math.max(1, Math.ceil(sortedValues.length * fraction)),
  );
  return sortedValues[rank - 1] ?? 0;
}
