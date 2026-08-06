import type { PanelMode } from "../../generated/session";
import type { PlotModeModule } from "./contract";
import { fftModule } from "./fft";
import { histogramModule } from "./histogram";
import { timeModule } from "./time";
import { xyModule } from "./xy";

const MODULES: Record<PanelMode, PlotModeModule<unknown>> = {
  time: timeModule as PlotModeModule<unknown>,
  xy: xyModule as PlotModeModule<unknown>,
  fft: fftModule as PlotModeModule<unknown>,
  histogram: histogramModule as PlotModeModule<unknown>,
};

/** The registry the panel and shell dispatch through — a fifth mode is one
 * new entry here plus its module file. */
export function plotModeModule(mode: PanelMode): PlotModeModule<unknown> {
  return MODULES[mode];
}
