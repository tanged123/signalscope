import {
  insidePlot,
  projectX,
  projectY,
  type PlotLayout,
} from "../app/plot-math";
import type { CursorMode as SessionCursorMode } from "../generated/session";
import { SERIES_TOKENS } from "./canvas-renderer";
import { CanvasSurface } from "./surface";

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

export interface OverlayAnnotation {
  x: number;
  y: number;
  colorIndex: number;
  label: string;
}

export interface OverlayDelta {
  label: string;
  first: XyMarker;
  second: XyMarker;
}

export interface OverlayState {
  cursorT: number | null;
  cursorMode: CursorMode;
  cursorPoints: readonly CursorPoint[];
  /** Data-space trajectory points marked by the global cursor (XY mode). */
  xyMarkers: readonly XyMarker[];
  box: { x0: number; y0: number; x1: number; y1: number } | null;
  /** Mode-resolved plot coordinates and readouts. */
  annotations: readonly OverlayAnnotation[];
  /** Mode-native delta geometry and copy. */
  delta: OverlayDelta | null;
}

export type CursorMode = SessionCursorMode;
export interface CursorPoint {
  value: number;
  colorIndex: number;
}

export interface XyMarker {
  x: number;
  y: number;
}

export class OverlayRenderer {
  private palette: OverlayPalette | null = null;
  private readonly surface: CanvasSurface;

  constructor(canvas: HTMLCanvasElement) {
    this.surface = new CanvasSurface(canvas);
  }

  setPalette(palette: OverlayPalette): void {
    this.palette = palette;
  }

  invalidateTheme(): void {
    this.palette = null;
  }

  draw(layout: PlotLayout | null, state: OverlayState): void {
    const { context, width, height } = this.surface.prepare();
    context.clearRect(0, 0, width, height);
    if (layout === null) return;
    const palette = this.resolvePalette();
    context.save();
    context.beginPath();
    context.rect(
      layout.plot.x,
      layout.plot.y,
      layout.plot.width,
      layout.plot.height,
    );
    context.clip();
    const cursorX =
      state.cursorT ??
      (state.cursorMode !== "none" ? (state.xyMarkers[0]?.x ?? null) : null);
    this.drawCursor(
      context,
      layout,
      cursorX,
      state.cursorMode,
      state.cursorPoints,
      palette,
    );
    this.drawXyMarkers(context, layout, state.xyMarkers, palette);
    this.drawAnnotations(context, layout, state, palette);
    if (state.box !== null) this.drawBox(context, layout, state.box, palette);
    context.restore();
  }

  private drawXyMarkers(
    context: CanvasRenderingContext2D,
    layout: PlotLayout,
    markers: readonly XyMarker[],
    palette: OverlayPalette,
  ): void {
    if (markers.length === 0) return;
    context.save();
    // Spec F2: r=4, surface fill, 1.6px amber stroke. Amber because the
    // marker is the cursor, not a series.
    context.lineWidth = 1.6;
    context.setLineDash([]);
    context.fillStyle = palette.surface0;
    context.strokeStyle = palette.amber;
    for (const marker of markers) {
      const x = projectX(layout, marker.x);
      const y = projectY(layout, marker.y);
      if (!insidePlot(layout, x, y)) continue;
      context.beginPath();
      context.arc(x, y, 4, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    }
    context.restore();
  }

  private drawCursor(
    context: CanvasRenderingContext2D,
    layout: PlotLayout,
    cursorT: number | null,
    cursorMode: CursorMode,
    cursorPoints: readonly CursorPoint[],
    palette: OverlayPalette,
  ): void {
    if (
      cursorMode === "none" ||
      cursorT === null ||
      cursorT < layout.xRange.min ||
      cursorT > layout.xRange.max
    ) {
      return;
    }
    const x = Math.round(projectX(layout, cursorT)) + 0.5;
    context.save();
    context.globalAlpha = 0.7;
    context.strokeStyle = palette.amber;
    context.lineWidth = 1;
    context.beginPath();
    context.setLineDash([2, 2]);
    context.moveTo(x, layout.plot.y);
    context.lineTo(x, layout.plot.y + layout.plot.height);
    context.stroke();
    if (cursorMode === "track") {
      context.setLineDash([]);
      context.lineWidth = 1.8;
      for (const point of cursorPoints) {
        const y = projectY(layout, point.value);
        if (y < layout.plot.y || y > layout.plot.y + layout.plot.height) {
          continue;
        }
        context.beginPath();
        context.fillStyle = palette.surface0;
        context.strokeStyle = palette.series[point.colorIndex] ?? palette.fg2;
        context.arc(x, y, 3, 0, Math.PI * 2);
        context.fill();
        context.stroke();
      }
    }
    context.restore();
  }

  private drawBox(
    context: CanvasRenderingContext2D,
    layout: PlotLayout,
    box: { x0: number; y0: number; x1: number; y1: number },
    palette: OverlayPalette,
  ): void {
    const right = layout.plot.x + layout.plot.width;
    const bottom = layout.plot.y + layout.plot.height;
    const x0 = Math.max(layout.plot.x, Math.min(right, box.x0));
    const x1 = Math.max(layout.plot.x, Math.min(right, box.x1));
    const y0 = Math.max(layout.plot.y, Math.min(bottom, box.y0));
    const y1 = Math.max(layout.plot.y, Math.min(bottom, box.y1));
    const x = Math.min(x0, x1);
    const y = Math.min(y0, y1);
    const width = Math.abs(x1 - x0);
    const height = Math.abs(y1 - y0);
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
        annotation.x < layout.xRange.min ||
        annotation.x > layout.xRange.max
      ) {
        return;
      }
      const x = projectX(layout, annotation.x);
      const y = projectY(layout, annotation.y);
      if (!insidePlot(layout, x, y)) return;
      context.beginPath();
      context.fillStyle = palette.surface0;
      context.strokeStyle =
        palette.series[annotation.colorIndex] ?? palette.fg2;
      context.lineWidth = 1.6;
      context.setLineDash([]);
      context.arc(x, y, 3.5, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      const text = `${marker(index)} ${annotation.label}`;
      const textWidth = context.measureText(text).width;
      const plateWidth = textWidth + 14;
      const right = layout.plot.x + layout.plot.width;
      const plateX = x + 7 + plateWidth > right ? x - plateWidth - 7 : x + 7;
      const plateY = y - 20 < layout.plot.y ? y + 4 : y - 20;
      context.fillStyle = palette.surface2;
      context.fillRect(plateX, plateY, plateWidth, 16);
      context.fillStyle = palette.fg1;
      context.fillText(text, plateX + 7, plateY + 12);
    });
    if (state.delta !== null) {
      this.drawDelta(context, layout, state.delta, palette);
    }
    context.restore();
  }

  private drawDelta(
    context: CanvasRenderingContext2D,
    layout: PlotLayout,
    delta: OverlayDelta,
    palette: OverlayPalette,
  ): void {
    context.save();
    context.strokeStyle = palette.fg3;
    context.globalAlpha = 0.6;
    context.lineWidth = 1;
    context.setLineDash([3, 3]);
    context.beginPath();
    context.moveTo(
      projectX(layout, delta.first.x),
      projectY(layout, delta.first.y),
    );
    context.lineTo(
      projectX(layout, delta.second.x),
      projectY(layout, delta.second.y),
    );
    context.stroke();
    context.restore();
    const text = delta.label;
    context.save();
    context.font = `10px ${palette.fontMono}`;
    const textWidth = context.measureText(text).width;
    const width = Math.min(textWidth + 16, layout.plot.width);
    const x = Math.max(
      layout.plot.x,
      layout.plot.x + layout.plot.width - width - 8,
    );
    const y = Math.max(
      layout.plot.y,
      Math.min(layout.plot.y + 6, layout.plot.y + layout.plot.height - 18),
    );
    context.fillStyle = palette.surface2;
    context.fillRect(x, y, width, 18);
    context.strokeStyle = palette.amber;
    context.globalAlpha = 0.4;
    context.lineWidth = 1;
    context.setLineDash([]);
    context.strokeRect(x + 0.5, y + 0.5, Math.max(0, width - 1), 17);
    context.globalAlpha = 1;
    context.fillStyle = palette.amber;
    context.fillText(text, x + 8, y + 13);
    context.restore();
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

/** Annotation badge glyph: circled digits ①–⑳, then parenthesised numbers. */
export function marker(index: number): string {
  return index < 20
    ? String.fromCodePoint(0x2460 + index)
    : `(${String(index + 1)})`;
}
