import type {
  ExportFidelity,
  HistogramResponse,
  SampleSeries,
} from "../generated/protocol";
import { lerpSample } from "./samples";

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

/** Serialize the exact aggregate result, preserving integer counts as strings. */
export function buildHistogramCsv(response: HistogramResponse): CsvExport {
  const unit = response.series[0]?.unit;
  const axisSuffix = unit === null || unit === undefined ? "" : ` [${unit}]`;
  const header = [
    quote(`bin_start${axisSuffix}`),
    quote(`bin_end${axisSuffix}`),
    "source_window_t0",
    "source_window_t1",
    ...response.series.map((series) => quote(`${series.signal_path} count`)),
  ];
  const lines = [header.join(",")];
  const bins = Math.max(0, response.edges.length - 1);
  for (let index = 0; index < bins; index += 1) {
    lines.push(
      [
        response.edges[index],
        response.edges[index + 1],
        response.window.t0,
        response.window.t1,
        ...response.series.map((series) => series.counts[index] ?? ""),
      ].join(","),
    );
  }
  return { text: `${lines.join("\n")}\n`, rows: bins, stride: 1 };
}
