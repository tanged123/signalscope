import type { ExportFidelity, SampleSeries } from "../generated/protocol";

export interface CsvExport {
  text: string;
  rows: number;
  stride: number;
}

export function csvMaxPoints(fidelity: ExportFidelity): number {
  switch (fidelity) {
    case "preview":
      return 512;
    case "standard":
      return 2_048;
    case "high":
      return 16_384;
    case "full":
      return 0xffff_ffff;
  }
}

function quote(path: string): string {
  return `"${path.replaceAll('"', '""')}"`;
}

export function lerpSample(
  time: readonly number[],
  values: readonly number[],
  query: number,
): number {
  const count = time.length;
  if (count === 0) return Number.NaN;
  if (query < (time[0] ?? 0) || query > (time[count - 1] ?? 0)) {
    return Number.NaN;
  }
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((time[mid] ?? 0) < query) low = mid + 1;
    else high = mid;
  }
  if ((time[low] ?? 0) === query) return values[low] ?? Number.NaN;
  const previous = Math.max(0, low - 1);
  const span = (time[low] ?? 0) - (time[previous] ?? 0);
  if (span === 0) return values[low] ?? Number.NaN;
  const alpha = (query - (time[previous] ?? 0)) / span;
  const before = values[previous] ?? Number.NaN;
  const after = values[low] ?? Number.NaN;
  return before + (after - before) * alpha;
}

export function buildCsv(
  series: SampleSeries[],
  window: { t0: number; t1: number },
): CsvExport {
  const [base, ...rest] = series;
  if (base === undefined) return { text: "time\n", rows: 0, stride: 1 };
  const lines = [
    ["time", ...series.map((item) => quote(item.signal_path))].join(","),
  ];
  let rows = 0;
  for (let index = 0; index < base.time.length; index += 1) {
    const time = base.time[index];
    if (time === undefined || time < window.t0 || time > window.t1) {
      continue;
    }
    const row = [time, base.values[index] ?? Number.NaN];
    for (const other of rest) {
      row.push(lerpSample(other.time, other.values, time));
    }
    lines.push(row.join(","));
    rows += 1;
  }
  return {
    text: `${lines.join("\n")}\n`,
    rows,
    stride: Math.max(1, ...series.map((item) => item.stride)),
  };
}
