import { histogram } from "../../app/histogram";
import { prepareHistogramPlot } from "../../app/plot-capabilities";
import type { SampleResponse } from "../../generated/protocol";
import type { PlotModeModule, ProjectResult } from "./contract";
import { colorIndexForHue, yLabel } from "./shared";

export interface HistogramGeometry {
  samples: SampleResponse | null;
}

export const histogramModule: PlotModeModule<HistogramGeometry> = {
  mode: "histogram",
  data: { reduction: "samples", windows: ["visible"] },
  configKey: () => "",
  prepare: ({ samples }) => ({ samples }),
  project(geometry, { state }, frame): ProjectResult {
    const samples = geometry.samples;
    if (samples === null) return { plot: { kind: "empty" }, prepared: null };
    const window = frame.window;
    const byPath = new Map(
      samples.series.map((series) => [series.signal_path, series]),
    );
    const visible = state.series.filter((series) => series.visible);
    const columns = visible.map((series) => {
      const source = byPath.get(series.path);
      if (source === undefined) return [];
      const values: number[] = [];
      source.time.forEach((time, index) => {
        if (time < window.t0 || time > window.t1) return;
        values.push(source.values[index] ?? Number.NaN);
      });
      return values;
    });
    const binned = histogram(columns);
    if (binned === null) {
      return {
        plot: { kind: "empty" },
        prepared: null,
        emptyState: { empty: true, note: "No values in view." },
      };
    }
    const edges = binned.edges;
    const histogramSeries: {
      path: string;
      colorIndex: number;
      counts: number[];
      sourceValues: number[];
    }[] = [];
    const paths = binned.counts.map((counts, index) => {
      const points: number[] = [];
      // A staircase outline: rise at each edge, run across each bin, and
      // close down to zero at both ends so the shape reads as a
      // distribution rather than a line chart.
      points.push(edges[0] ?? 0, 0);
      counts.forEach((count, bin) => {
        points.push(edges[bin] ?? 0, count, edges[bin + 1] ?? 0, count);
      });
      points.push(edges[edges.length - 1] ?? 0, 0);
      const series = visible[index];
      if (series !== undefined) {
        histogramSeries.push({
          path: series.path,
          colorIndex: colorIndexForHue(series.hue),
          counts,
          sourceValues: columns[index] ?? [],
        });
      }
      return {
        points,
        hue: series?.hue ?? null,
        dash: series?.dash ?? ("solid" as const),
        width: series?.width ?? 1.4,
        alpha: series?.opacity ?? 1,
      };
    });
    const prepared = prepareHistogramPlot({ edges, series: histogramSeries });
    const emptyState = { empty: false, note: "No values in view." };
    const ranges = frame.resolveRanges(prepared);
    if (ranges === null)
      return { plot: { kind: "empty" }, prepared, emptyState };
    const units = visible.map(
      (series) => byPath.get(series.path)?.unit ?? null,
    );
    return {
      plot: {
        kind: "paths",
        paths,
        options: {
          xLabel: state.x_label ?? yLabel(units),
          yLabel: state.y_label ?? "sample count",
          xRange: [ranges.x.min, ranges.x.max],
          yRange: [ranges.y.min, ranges.y.max],
          axisStyle: state.axis_style,
        },
      },
      prepared,
      emptyState,
    };
  },
};
