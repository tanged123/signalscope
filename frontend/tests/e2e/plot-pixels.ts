/// <reference types="@webgpu/types" />
/* eslint-disable @typescript-eslint/unbound-method -- the readback wraps WebGPU prototype methods and calls each original with its receiver. */
import type { Locator, Page } from "@playwright/test";

/**
 * Headless SwiftShader presents WebGPU canvases without exposing them to page
 * screenshots, so read back what each canvas actually presented: every
 * submit copies freshly acquired swap-chain textures into mapped buffers.
 */
export async function installPlotReadback(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const frames = new Map<HTMLCanvasElement, string>();
    const devices = new WeakMap<GPUCanvasContext, GPUDevice>();
    const acquired = new Map<
      HTMLCanvasElement,
      { texture: GPUTexture; device: GPUDevice }
    >();
    const busy = new WeakSet<HTMLCanvasElement>();
    const configure = GPUCanvasContext.prototype.configure;
    GPUCanvasContext.prototype.configure = function (config) {
      devices.set(this, config.device);
      configure.call(this, {
        ...config,
        usage:
          (config.usage ?? GPUTextureUsage.RENDER_ATTACHMENT) |
          GPUTextureUsage.COPY_SRC,
      });
    };
    const currentTexture = GPUCanvasContext.prototype.getCurrentTexture;
    GPUCanvasContext.prototype.getCurrentTexture = function () {
      const texture = currentTexture.call(this);
      const device = devices.get(this);
      if (device !== undefined && this.canvas instanceof HTMLCanvasElement)
        acquired.set(this.canvas, { texture, device });
      return texture;
    };
    const submit = GPUQueue.prototype.submit;
    GPUQueue.prototype.submit = function (commands) {
      submit.call(this, commands);
      for (const [canvas, { texture, device }] of acquired) {
        if (busy.has(canvas) || device.queue !== this) continue;
        acquired.delete(canvas);
        busy.add(canvas);
        const { width, height } = texture;
        const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
        const buffer = device.createBuffer({
          size: bytesPerRow * height,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        // A resize can destroy an acquired texture before the next submit;
        // keep the readback's own validation errors away from the app.
        device.pushErrorScope("validation");
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer(
          { texture },
          { buffer, bytesPerRow },
          { width, height },
        );
        submit.call(this, [encoder.finish()]);
        void device.popErrorScope();
        const bgra = texture.format.startsWith("bgra");
        void buffer
          .mapAsync(GPUMapMode.READ)
          .then(() => {
            const source = new Uint8Array(buffer.getMappedRange());
            const frame = document.createElement("canvas");
            frame.width = width;
            frame.height = height;
            const context = frame.getContext("2d");
            if (context === null) return;
            const image = context.createImageData(width, height);
            for (let y = 0; y < height; y += 1) {
              for (let x = 0; x < width; x += 1) {
                const from = y * bytesPerRow + x * 4;
                const to = (y * width + x) * 4;
                image.data[to] = source[from + (bgra ? 2 : 0)] ?? 0;
                image.data[to + 1] = source[from + 1] ?? 0;
                image.data[to + 2] = source[from + (bgra ? 0 : 2)] ?? 0;
                image.data[to + 3] = 255;
              }
            }
            context.putImageData(image, 0, 0);
            frames.set(canvas, frame.toDataURL("image/png"));
            buffer.unmap();
          })
          .catch(() => undefined)
          .finally(() => {
            buffer.destroy();
            busy.delete(canvas);
          });
      }
    };
    (
      window as unknown as {
        __plotFrame: (panel: Element) => string | null;
      }
    ).__plotFrame = (panel) => {
      for (const canvas of panel.querySelectorAll("canvas")) {
        const frame = frames.get(canvas);
        if (frame !== undefined) return frame;
      }
      return null;
    };
  });
}

/** The latest presented WebGPU frame of a panel as a PNG data URL. */
export async function plotFrame(panel: Locator): Promise<string | null> {
  return panel.evaluate((element) =>
    (
      window as unknown as {
        __plotFrame: (panel: Element) => string | null;
      }
    ).__plotFrame(element),
  );
}

export interface FrameComparison {
  /** Pixels that differ from the frame's background colour. */
  inkA: number;
  inkB: number;
  /** Share of ink pixels with ink within 2 px in the other frame. */
  overlap: number;
}

/** Compares two frames by where they draw, tolerating 2 px placement noise. */
export async function compareFrames(
  page: Page,
  a: string,
  b: string,
): Promise<FrameComparison> {
  return page.evaluate(
    async ([first, second]) => {
      const pixels = async (url: string) => {
        const image = new Image();
        image.src = url;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d");
        if (context === null) throw new Error("2d context unavailable");
        context.drawImage(image, 0, 0);
        const { data, width, height } = context.getImageData(
          0,
          0,
          image.width,
          image.height,
        );
        const ink = new Uint8Array(width * height);
        const background = [data[0], data[1], data[2]];
        for (let index = 0; index < width * height; index += 1) {
          const distance =
            Math.abs((data[index * 4] ?? 0) - (background[0] ?? 0)) +
            Math.abs((data[index * 4 + 1] ?? 0) - (background[1] ?? 0)) +
            Math.abs((data[index * 4 + 2] ?? 0) - (background[2] ?? 0));
          ink[index] = distance > 60 ? 1 : 0;
        }
        return { ink, width, height };
      };
      const one = await pixels(first);
      const two = await pixels(second);
      const near = (frame: typeof one, x: number, y: number): boolean => {
        for (let dy = -2; dy <= 2; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) {
            const px = x + dx;
            const py = y + dy;
            if (px < 0 || py < 0 || px >= frame.width || py >= frame.height)
              continue;
            if (frame.ink[py * frame.width + px] === 1) return true;
          }
        }
        return false;
      };
      let inkA = 0;
      let inkB = 0;
      let matched = 0;
      for (let y = 0; y < one.height; y += 1) {
        for (let x = 0; x < one.width; x += 1) {
          if (one.ink[y * one.width + x] !== 1) continue;
          inkA += 1;
          if (near(two, x, y)) matched += 1;
        }
      }
      for (let y = 0; y < two.height; y += 1) {
        for (let x = 0; x < two.width; x += 1) {
          if (two.ink[y * two.width + x] !== 1) continue;
          inkB += 1;
          if (near(one, x, y)) matched += 1;
        }
      }
      return {
        inkA,
        inkB,
        overlap: inkA + inkB === 0 ? 1 : matched / (inkA + inkB),
      };
    },
    [a, b] as const,
  );
}
