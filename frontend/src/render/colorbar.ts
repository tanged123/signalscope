import { viridis, type ColorScale } from "../app/color-scale";
import type { Palette } from "./plot-theme";

const HEIGHT = 54;
const FALLBACK_WIDTH = 220;

/** Owns one scale canvas, reparented between legend and plot without GPU changes. */
export class Colorbar {
  readonly canvas = document.createElement("canvas");
  private target: HTMLElement | null = null;
  private signature = "";
  private scale: ColorScale | undefined;
  private palette: Palette | null = null;

  constructor(private readonly container: HTMLElement) {
    this.canvas.className = "colorbar-canvas";
    this.canvas.setAttribute("role", "img");
    this.canvas.hidden = true;
    container.append(this.canvas);
  }

  attach(target: HTMLElement | null): void {
    this.target = target;
    const parent = target ?? this.container;
    if (this.canvas.parentElement !== parent) {
      parent.append(this.canvas);
      this.signature = "";
    }
  }

  render(
    scale: ColorScale | undefined,
    palette: Palette,
    bottom: number,
  ): void {
    this.scale = scale;
    this.palette = palette;
    this.canvas.hidden = scale === undefined;
    if (scale === undefined) {
      this.signature = "";
      return;
    }
    const embedded = this.target !== null;
    const width = embedded
      ? (this.target?.clientWidth ?? 0)
      : Math.min(FALLBACK_WIDTH, Math.max(1, this.container.clientWidth - 16));
    const dpr = window.devicePixelRatio || 1;
    this.canvas.dataset.placement = embedded ? "legend" : "plot";
    const signature = JSON.stringify([
      scale,
      palette,
      width,
      dpr,
      embedded,
      bottom,
    ]);
    if (signature === this.signature) return;
    this.signature = signature;
    this.canvas.style.cssText = embedded
      ? "display:block;pointer-events:none"
      : `position:absolute;right:8px;bottom:${String(bottom + 8)}px;pointer-events:none`;
    this.canvas.title = scale.label;
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.round(HEIGHT * dpr);
    this.canvas.style.width = `${String(width)}px`;
    this.canvas.style.height = `${String(HEIGHT)}px`;
    this.canvas.setAttribute(
      "aria-label",
      `C axis: ${scale.label}; ${scale.range === null ? "no finite color data" : `${String(scale.range[0])} to ${String(scale.range[1])}`}`,
    );
    const context = this.canvas.getContext("2d");
    if (context === null) return;
    context.scale(dpr, dpr);
    paint(context, scale, palette, width, embedded);
  }

  /** Plot PNGs omit legend chrome, so retain the scale as a compact inset. */
  capture(target: HTMLCanvasElement, bottom: number): void {
    if (this.scale === undefined || this.palette === null) return;
    const context = target.getContext("2d");
    if (context === null) return;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.min(
      FALLBACK_WIDTH,
      Math.max(1, target.width / dpr - 16),
    );
    context.save();
    context.scale(dpr, dpr);
    context.translate(
      target.width / dpr - width - 8,
      Math.max(0, target.height / dpr - HEIGHT - bottom - 8),
    );
    paint(context, this.scale, this.palette, width, false);
    context.restore();
  }

  dispose(): void {
    this.canvas.remove();
    this.target = null;
  }
}

function paint(
  context: CanvasRenderingContext2D,
  scale: ColorScale,
  palette: Palette,
  width: number,
  embedded: boolean,
): void {
  if (!embedded) {
    context.fillStyle = palette.background;
    context.fillRect(0, 0, width, HEIGHT);
    context.strokeStyle = palette.border;
    context.strokeRect(0.5, 0.5, width - 1, HEIGHT - 1);
  }
  const left = 8;
  const barWidth = Math.max(1, width - left * 2);
  context.font = `9.5px ${palette.fontPlot}`;
  context.textAlign = "left";
  context.fillStyle = palette.fg2;
  context.textBaseline = "middle";
  context.fillText(
    `${embedded ? "color ← " : ""}${scale.label}${embedded ? " ▾" : ""}`,
    left,
    11,
    barWidth,
  );
  const range = scale.range;
  for (let column = 0; column < barWidth; column += 1) {
    const [r, g, b] = viridis(
      range?.[0] === range?.[1] ? 0.5 : column / Math.max(1, barWidth - 1),
    );
    context.fillStyle =
      range === null
        ? palette.fg4
        : `rgb(${String(Math.round(r * 255))},${String(Math.round(g * 255))},${String(Math.round(b * 255))})`;
    context.fillRect(left + column, 23, 1, 8);
  }
  context.fillStyle = palette.fg3;
  context.font = `9px ${palette.fontPlot}`;
  if (range === null) {
    context.fillText("no finite color data", left, 43, barWidth);
    return;
  }
  const [min, max] = range;
  const fractions =
    min === max ? [0.5] : barWidth >= 180 ? [0, 0.5, 1] : [0, 1];
  for (const fraction of fractions) {
    const x = left + fraction * barWidth;
    context.fillRect(x, 31, 1, 3);
    context.textAlign =
      fraction === 0 ? "left" : fraction === 1 ? "right" : "center";
    const value = min * (1 - fraction) + max * fraction;
    context.fillText(
      Number(value.toPrecision(3)).toString(),
      x,
      44,
      barWidth / fractions.length,
    );
  }
}
