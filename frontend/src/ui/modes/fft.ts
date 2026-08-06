import { prepareFftPlot } from "../../app/plot-capabilities";
import { spectrum } from "../../app/spectrum";
import type { SampleResponse } from "../../generated/protocol";
import type { PlotPath } from "../../render/canvas-renderer";
import type {
  DomainSeriesEntry,
  PlotModeModule,
  ProjectResult,
} from "./contract";
import { colorIndexForHue } from "./shared";

export interface FftGeometry {
  samples: SampleResponse | null;
}

export const fftModule: PlotModeModule<FftGeometry> = {
  mode: "fft",
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
    const paths: PlotPath[] = [];
    const domainSeries: DomainSeriesEntry[] = [];
    for (const series of state.series) {
      if (!series.visible) continue;
      const source = byPath.get(series.path);
      if (source === undefined) continue;
      const result = spectrum(source, window.t0, window.t1);
      if (result === null) continue;
      const points: number[] = [];
      result.frequency.forEach((frequency, index) => {
        points.push(frequency, result.amplitudeDb[index] ?? -120);
      });
      domainSeries.push({
        path: series.path,
        colorIndex: colorIndexForHue(series.hue),
        hue: series.hue,
        opacity: series.opacity,
        x: result.frequency,
        y: result.amplitudeDb,
      });
      paths.push({
        points,
        hue: series.hue,
        dash: series.dash,
        width: series.width,
        alpha: series.opacity,
      });
    }
    const emptyState = {
      empty: paths.length === 0,
      note: "Not enough samples in view.",
    };
    const prepared = prepareFftPlot({
      series: domainSeries.map((series) => ({
        path: series.path,
        colorIndex: series.colorIndex,
        frequency: series.x,
        amplitudeDb: series.y,
      })),
    });
    if (paths.length === 0) {
      return { plot: { kind: "empty" }, prepared, domainSeries, emptyState };
    }
    const ranges = frame.resolveRanges(prepared);
    if (ranges === null) {
      return { plot: { kind: "empty" }, prepared, domainSeries, emptyState };
    }
    return {
      plot: {
        kind: "paths",
        paths,
        options: {
          xLabel: state.x_label ?? "frequency (Hz), log",
          yLabel: state.y_label ?? "amplitude (dB)",
          xRange: [ranges.x.min, ranges.x.max],
          yRange: [ranges.y.min, ranges.y.max],
          axisStyle: state.axis_style,
          xScale: "log",
        },
      },
      prepared,
      domainSeries,
      emptyState,
    };
  },
};
