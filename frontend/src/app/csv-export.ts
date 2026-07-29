import type { SampleSeries } from "../generated/protocol";
import { lerpSample } from "./xy";

export const CSV_SAMPLE_CAP = 65_536;

function quote(path: string): string {
  return `"${path.replaceAll('"', '""')}"`;
}

export function buildCsv(
  series: SampleSeries[],
  window: { t0: number; t1: number },
): string {
  const [base, ...rest] = series;
  if (base === undefined) return "time\n";
  const lines = series
    .filter((item) => item.stride > 1)
    .map(
      (item) => `# stride,${quote(item.signal_path)},1:${String(item.stride)}`,
    );
  lines.push(
    ["time", ...series.map((item) => quote(item.signal_path))].join(","),
  );
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
  }
  return `${lines.join("\n")}\n`;
}
