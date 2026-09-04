import type { StatColumn } from "../generated/session";

export interface LegendStatValues {
  min: number | null;
  max: number | null;
  mean: number | null;
  rms: number | null;
  n: number | null;
  cursor: number | null;
}

export function emptyLegendStats(): LegendStatValues {
  return { min: null, max: null, mean: null, rms: null, n: null, cursor: null };
}

export function aggregateLegendStats(
  rows: readonly LegendStatValues[],
  mixedUnits = false,
): LegendStatValues {
  const finite = (column: StatColumn): number[] =>
    rows.flatMap((row) => {
      const value = row[column];
      return value === null ? [] : [value];
    });
  const min = finite("min");
  const max = finite("max");
  const weighted = (column: "mean" | "rms"): number | null => {
    let total = 0;
    let weight = 0;
    for (const row of rows) {
      const value = row[column];
      const count = row.n;
      if (
        value === null ||
        count === null ||
        !Number.isFinite(value) ||
        !Number.isFinite(count) ||
        count <= 0
      ) {
        continue;
      }
      total += column === "rms" ? count * value ** 2 : count * value;
      weight += count;
    }
    if (weight === 0) return null;
    return column === "rms" ? Math.sqrt(total / weight) : total / weight;
  };
  const counts = finite("n");
  const cursor = finite("cursor");
  return {
    min: mixedUnits || min.length === 0 ? null : Math.min(...min),
    max: mixedUnits || max.length === 0 ? null : Math.max(...max),
    mean: mixedUnits ? null : weighted("mean"),
    rms: mixedUnits ? null : weighted("rms"),
    n:
      counts.length === 0
        ? null
        : counts.reduce((total, value) => total + value, 0),
    cursor: mixedUnits ? null : average(cursor),
  };
}

export function statGridTemplate(columns: number): string {
  return `minmax(128px, 1fr) minmax(56px, 1fr) repeat(${String(columns)}, 64px)`;
}

export function statSpanDomain(
  rows: readonly LegendStatValues[],
): readonly [number, number] | null {
  const minima = rows.flatMap((row) => (row.min === null ? [] : [row.min]));
  const maxima = rows.flatMap((row) => (row.max === null ? [] : [row.max]));
  return minima.length === 0 || maxima.length === 0
    ? null
    : [Math.min(...minima), Math.max(...maxima)];
}

export function statSpan(
  values: LegendStatValues,
  domain: readonly [number, number] | null,
  color: string,
): HTMLElement {
  const cell = document.createElement("span");
  cell.className = "plot-stat-span";
  const track = document.createElement("span");
  track.className = "plot-stat-span-track";
  cell.append(track);
  if (values.min === null || values.max === null || domain === null)
    return cell;
  cell.title = `min ${formatStatValue(values.min)} · max ${formatStatValue(values.max)} · μ ${formatStatValue(values.mean)}`;
  const extent = domain[1] - domain[0];
  const position = (value: number): number =>
    extent === 0 ? 50 : ((value - domain[0]) / extent) * 100;
  const band = document.createElement("span");
  band.className = "plot-stat-span-band";
  band.style.background = color;
  band.style.left = `${String(position(values.min))}%`;
  band.style.right = `${String(100 - position(values.max))}%`;
  track.append(band);
  if (values.mean !== null) {
    const mean = document.createElement("span");
    mean.className = "plot-stat-span-mean";
    mean.style.left = `${String(position(values.mean))}%`;
    track.append(mean);
  }
  return cell;
}

export function statHistogram(values: readonly (number | null)[]): HTMLElement {
  const cell = document.createElement("span");
  cell.className = "plot-stat-histogram";
  const finite = values.filter((value): value is number => value !== null);
  if (finite.length === 0) return cell;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const bins = Array.from({ length: 7 }, () => 0);
  for (const value of finite) {
    const index =
      max === min
        ? 3
        : Math.min(6, Math.floor(((value - min) / (max - min)) * 7));
    bins[index] = (bins[index] ?? 0) + 1;
  }
  const peak = Math.max(...bins);
  for (const count of bins) {
    const bar = document.createElement("span");
    bar.style.height = `${String((count / peak) * 100)}%`;
    cell.append(bar);
  }
  return cell;
}

export function statColumnLabel(
  column: StatColumn,
  unit: string | null = null,
): string {
  const label =
    column === "mean"
      ? "μ"
      : column === "cursor"
        ? "@CUR"
        : column.toUpperCase();
  return unit === null || unit === "" ? label : `${label} (${unit})`;
}

export function statCell(
  value: number | null,
  column: StatColumn,
  unit: string | null = null,
): HTMLElement {
  const cell = document.createElement("span");
  cell.className = "plot-stat-cell";
  cell.dataset.column = column;
  if (unit !== null && unit !== "") cell.dataset.unit = unit;
  setStatCellValue(cell, value, unit);
  return cell;
}

export function setStatCellValue(
  cell: HTMLElement,
  value: number | null,
  unit: string | null,
): void {
  cell.replaceChildren(formatStatValue(value));
  if (value !== null && unit !== null && unit !== "") {
    const suffix = document.createElement("span");
    suffix.className = "plot-stat-unit";
    suffix.textContent = ` ${unit}`;
    cell.append(suffix);
  }
}

export function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function safeFilename(value: string): string {
  const safe = value.trim().replaceAll(/[^a-zA-Z0-9._-]+/g, "-");
  return safe === "" ? "panel" : safe;
}

export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function average(values: readonly number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function formatStatValue(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value === 0) return "0.000";
  const absolute = Math.abs(value);
  if (absolute >= 10_000 || absolute < 0.001) return value.toExponential(3);
  return Number(value.toPrecision(4)).toString();
}
