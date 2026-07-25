import type { Annotation } from "../generated/session";
import {
  formatValue,
  projectX,
  projectY,
  type PlotLayout,
} from "../app/plot-math";
import { SERIES_TOKENS } from "./canvas-renderer";

export interface OverlayPalette {
  amber: string;
  amberFill: string;
  fg1: string;
  fg2: string;
  fg3: string;
  surface0: string;
  surface2: string;
  fontMono: string;
  series: string[];
}

export interface OverlayState {
  cursorT: number | null;
  box: { x0: number; y0: number; x1: number; y1: number } | null;
  annotations: readonly Annotation[];
  annotationColorIndices: readonly number[];
  showDelta: boolean;
}

export class OverlayRenderer {
  private palette: OverlayPalette | null = null;
  private renderedWidth = 0;
  private renderedHeight = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  setPalette(palette: OverlayPalette): void {
    this.palette = palette;
  }

  invalidateTheme(): void {
    this.palette = null;
  }

  draw(layout: PlotLayout | null, state: OverlayState): void {
    const { context, width, height } = this.prepareCanvas();
    context.clearRect(0, 0, width, height);
    if (layout === null) return;
    const palette = this.resolvePalette();
    this.drawCursor(context, layout, state.cursorT, palette);
    this.drawAnnotations(context, layout, state, palette);
    if (state.box !== null) this.drawBox(context, state.box, palette);
  }

  private drawCursor(
    context: CanvasRenderingContext2D,
    layout: PlotLayout,
    cursorT: number | null,
    palette: OverlayPalette,
  ): void {
    if (
      cursorT === null ||
      cursorT < layout.xRange.min ||
      cursorT > layout.xRange.max
    ) {
      return;
    }
    const x = Math.round(projectX(layout, cursorT)) + 0.5;
    context.save();
    context.strokeStyle = palette.amber;
    context.globalAlpha = 0.7;
    context.lineWidth = 1;
    context.setLineDash([2, 2]);
    context.beginPath();
    context.moveTo(x, layout.plot.y);
    context.lineTo(x, layout.plot.y + layout.plot.height);
    context.stroke();
    context.restore();
  }

  private drawBox(
    context: CanvasRenderingContext2D,
    box: { x0: number; y0: number; x1: number; y1: number },
    palette: OverlayPalette,
  ): void {
    const x = Math.min(box.x0, box.x1);
    const y = Math.min(box.y0, box.y1);
    const width = Math.abs(box.x1 - box.x0);
    const height = Math.abs(box.y1 - box.y0);
    context.save();
    context.fillStyle = palette.amberFill;
    context.fillRect(x, y, width, height);
    context.strokeStyle = palette.amber;
    context.lineWidth = 1;
    context.setLineDash([5, 4]);
    context.strokeRect(x + 0.5, y + 0.5, width, height);
    context.restore();
  }

  private drawAnnotations(
    context: CanvasRenderingContext2D,
    layout: PlotLayout,
    state: OverlayState,
    palette: OverlayPalette,
  ): void {
    context.save();
    context.font = `10px ${palette.fontMono}`;
    state.annotations.forEach((annotation, index) => {
      if (
        annotation.time < layout.xRange.min ||
        annotation.time > layout.xRange.max
      ) {
        return;
      }
      const x = projectX(layout, annotation.time);
      const y = projectY(layout, annotation.value);
      context.beginPath();
      context.fillStyle = palette.surface0;
      context.strokeStyle =
        palette.series[state.annotationColorIndices[index] ?? -1] ??
        palette.fg2;
      context.lineWidth = 1.6;
      context.setLineDash([]);
      context.arc(x, y, 3.5, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      const label = annotation.label === "" ? "" : ` ${annotation.label}`;
      const text = `${marker(index)}${label} ${formatValue(annotation.value)} @ ${annotation.time.toFixed(3)}`;
      const textWidth = context.measureText(text).width;
      context.fillStyle = palette.surface2;
      context.fillRect(x + 7, y - 20, textWidth + 14, 16);
      context.fillStyle = palette.fg1;
      context.fillText(text, x + 14, y - 8);
    });
    if (state.showDelta && state.annotations.length >= 2) {
      this.drawDelta(context, layout, state.annotations, palette);
    }
    context.restore();
  }

  private drawDelta(
    context: CanvasRenderingContext2D,
    layout: PlotLayout,
    annotations: readonly Annotation[],
    palette: OverlayPalette,
  ): void {
    const first = annotations[annotations.length - 2];
    const second = annotations[annotations.length - 1];
    if (first === undefined || second === undefined) return;
    context.save();
    context.strokeStyle = palette.fg3;
    context.globalAlpha = 0.6;
    context.lineWidth = 1;
    context.setLineDash([3, 3]);
    context.beginPath();
    context.moveTo(projectX(layout, first.time), projectY(layout, first.value));
    context.lineTo(
      projectX(layout, second.time),
      projectY(layout, second.value),
    );
    context.stroke();
    context.restore();
    const deltaT = second.time - first.time;
    const deltaV = second.value - first.value;
    const slope = deltaT === 0 ? null : deltaV / deltaT;
    const parts = [`Δt ${formatValue(deltaT)} s`, `Δv ${formatValue(deltaV)}`];
    if (slope !== null) parts.push(`slope ${formatValue(slope)}/s`);
    const text = parts.join(" · ");
    context.save();
    context.font = `10px ${palette.fontMono}`;
    const textWidth = context.measureText(text).width;
    const x = layout.plot.x + layout.plot.width - textWidth - 24;
    const y = layout.plot.y + 6;
    context.fillStyle = palette.surface2;
    context.fillRect(x, y, textWidth + 16, 18);
    context.strokeStyle = palette.amber;
    context.globalAlpha = 0.4;
    context.lineWidth = 1;
    context.setLineDash([]);
    context.strokeRect(x + 0.5, y + 0.5, textWidth + 15, 17);
    context.globalAlpha = 1;
    context.fillStyle = palette.amber;
    context.fillText(text, x + 8, y + 13);
    context.restore();
  }

  private prepareCanvas(): {
    context: CanvasRenderingContext2D;
    width: number;
    height: number;
  } {
    const ratio = globalThis.devicePixelRatio || 1;
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    const backingWidth = Math.round(width * ratio);
    const backingHeight = Math.round(height * ratio);
    if (
      backingWidth !== this.renderedWidth ||
      backingHeight !== this.renderedHeight
    ) {
      this.canvas.width = backingWidth;
      this.canvas.height = backingHeight;
      this.renderedWidth = backingWidth;
      this.renderedHeight = backingHeight;
    }
    const context = this.canvas.getContext("2d");
    if (context === null) throw new Error("Canvas 2D context is unavailable");
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { context, width, height };
  }

  private resolvePalette(): OverlayPalette {
    if (this.palette !== null) return this.palette;
    const styles = getComputedStyle(document.documentElement);
    const token = (name: string): string =>
      styles.getPropertyValue(name).trim();
    this.palette = {
      amber: token("--amber-7"),
      amberFill: token("--amber-3"),
      fg1: token("--fg-1"),
      fg2: token("--fg-2"),
      fg3: token("--fg-3"),
      surface0: token("--surface-0"),
      surface2: token("--surface-2"),
      fontMono: token("--font-mono") || '"JetBrains Mono", monospace',
      series: SERIES_TOKENS.map((name) => token(name)),
    };
    return this.palette;
  }
}

function marker(index: number): string {
  return index < 20
    ? String.fromCodePoint(0x2460 + index)
    : `(${String(index + 1)})`;
}
