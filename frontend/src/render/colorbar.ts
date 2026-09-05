import { viridis, type ColorScale } from "../app/color-scale";
import type { Palette } from "./plot-theme";

export const COLORBAR_GUTTER = 64;

export class Colorbar {
  private readonly canvas = document.createElement("canvas");
  private signature = "";
  constructor(private readonly container: HTMLElement) {
    this.canvas.className = "colorbar-canvas";
    this.canvas.style.cssText = "position:absolute;inset:0;pointer-events:none";
    this.canvas.setAttribute("role", "img");
    this.canvas.hidden = true;
    container.append(this.canvas);
  }

  render(
    scale: ColorScale | undefined,
    palette: Palette,
    top: number,
    bottom: number,
  ): void {
    this.canvas.hidden = scale === undefined;
    if (scale === undefined) {
      this.signature = "";
      return;
    }
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    const signature = JSON.stringify([
      scale,
      palette,
      width,
      height,
      dpr,
      top,
      bottom,
    ]);
    if (signature === this.signature) return;
    this.signature = signature;
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
    this.canvas.style.width = `${String(width)}px`;
    this.canvas.style.height = `${String(height)}px`;
    this.canvas.setAttribute(
      "aria-label",
      `C axis: ${scale.label}; ${scale.range === null ? "no finite color data" : `${String(scale.range[0])} to ${String(scale.range[1])}`}`,
    );
    const ctx = this.canvas.getContext("2d");
    if (ctx === null) return;
    ctx.scale(dpr, dpr);
    const x = width - COLORBAR_GUTTER + 6;
    const barHeight = Math.max(1, height - top - bottom);
    if (scale.range !== null) {
      for (let row = 0; row < barHeight; row += 1) {
        const [r, g, b] = viridis(1 - row / Math.max(1, barHeight - 1));
        ctx.fillStyle = `rgb(${String(Math.round(r * 255))},${String(Math.round(g * 255))},${String(Math.round(b * 255))})`;
        ctx.fillRect(x, top + row, 12, 1);
      }
      ctx.fillStyle = palette.fg3;
      ctx.font = `9px ${palette.fontPlot}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const [min, max] = scale.range;
      const fractions =
        min === max
          ? [0.5]
          : barHeight < 160
            ? [0, 0.5, 1]
            : [0, 0.25, 0.5, 0.75, 1];
      for (const fraction of fractions) {
        const y = top + (1 - fraction) * barHeight;
        const value = min * (1 - fraction) + max * fraction;
        ctx.fillRect(x + 12, y, 3, 1);
        const text = Number(value.toPrecision(3)).toString();
        ctx.fillText(text, x + 17, Math.min(height - 5, Math.max(5, y)), 29);
      }
    } else {
      ctx.fillStyle = palette.fg4;
      ctx.fillRect(x, top, 12, barHeight);
    }
    ctx.save();
    ctx.translate(width - 4, top + barHeight / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.font = `9.5px ${palette.fontPlot}`;
    ctx.fillStyle = palette.fg2;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(
      scale.range === null
        ? `${scale.label} · no finite color data`
        : scale.label,
      0,
      0,
      barHeight,
    );
    ctx.restore();
  }

  dispose(): void {
    this.canvas.remove();
  }
}
