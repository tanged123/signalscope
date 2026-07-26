/**
 * Backing-store sizing for a plot canvas.
 *
 * The plot and overlay canvases are stacked and must agree on device-pixel
 * geometry, so the DPR policy lives here once rather than in each renderer.
 */
export class CanvasSurface {
  private renderedWidth = 0;
  private renderedHeight = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  /** Resizes the backing store when needed and returns a CSS-pixel context. */
  prepare(): {
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
    if (context === null) {
      throw new Error("Canvas 2D context is unavailable");
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { context, width, height };
  }
}
