const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = 0x0010;
const MSAA_SAMPLE_COUNT = 4;

export class PanelRenderTargets {
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private format: GPUTextureFormat | null = null;
  private width = 0;
  private height = 0;
  private msaaTexture: GPUTexture | null = null;

  configure(
    device: GPUDevice,
    context: GPUCanvasContext,
    format: GPUTextureFormat,
  ): void {
    if (
      this.device === device &&
      this.context === context &&
      this.format === format
    ) {
      return;
    }
    this.destroyTexture();
    this.device = device;
    this.context = context;
    this.format = format;
    this.width = 0;
    this.height = 0;
  }

  resize(width: number, height: number): void {
    const nextWidth = Math.max(1, Math.trunc(width));
    const nextHeight = Math.max(1, Math.trunc(height));
    if (nextWidth === this.width && nextHeight === this.height) return;
    this.width = nextWidth;
    this.height = nextHeight;
    this.destroyTexture();
    if (this.device === null || this.format === null) return;
    this.msaaTexture = this.device.createTexture({
      label: "signalscope-panel-msaa",
      size: {
        width: nextWidth,
        height: nextHeight,
        depthOrArrayLayers: 1,
      },
      format: this.format,
      sampleCount: MSAA_SAMPLE_COUNT,
      usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
    });
  }

  frame(): { swapchain: GPUTextureView; msaa: GPUTextureView } {
    if (this.context === null || this.msaaTexture === null) {
      throw new Error("panel render targets are not configured");
    }
    return {
      swapchain: this.context.getCurrentTexture().createView(),
      msaa: this.msaaTexture.createView(),
    };
  }

  destroy(): void {
    this.destroyTexture();
    this.device = null;
    this.context = null;
    this.format = null;
    this.width = 0;
    this.height = 0;
  }

  private destroyTexture(): void {
    this.msaaTexture?.destroy();
    this.msaaTexture = null;
  }
}

export const PANEL_MSAA_SAMPLE_COUNT = MSAA_SAMPLE_COUNT;
