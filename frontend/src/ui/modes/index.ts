import type { PanelMode } from "../../generated/session";
import type { PlotModeModule } from "./contract";
import { fftModule } from "./fft";
import { histogramModule } from "./histogram";
import { timeModule } from "./time";
import { xyModule } from "./xy";

const MODULES: Record<PanelMode, PlotModeModule> = {
  time: timeModule,
  xy: xyModule,
  fft: fftModule,
  histogram: histogramModule,
};

/** The registry the panel and shell dispatch through — a fifth mode is one
 * new entry here plus its module file. */
export function plotModeModule(mode: PanelMode): PlotModeModule {
  return MODULES[mode];
}
