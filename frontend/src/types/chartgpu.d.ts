interface GPUDevice {
  readonly queue: unknown;
  destroy(): void;
}

interface GPUAdapter {
  requestDevice(): Promise<GPUDevice>;
}

interface GPU {
  requestAdapter(options?: {
    powerPreference?: "low-power" | "high-performance";
  }): Promise<GPUAdapter | null>;
}

interface Navigator {
  readonly gpu?: GPU;
}

declare module "@chartgpu/chartgpu" {
  export interface XYArraysData {
    x: ArrayLike<number>;
    y: ArrayLike<number>;
    size?: ArrayLike<number>;
  }

  export interface LineSeriesConfig {
    type: "line";
    name?: string;
    data: XYArraysData | ArrayBufferView;
    sampling?: "none" | "lttb" | "average" | "max" | "min";
    lineStyle?: {
      width?: number;
      opacity?: number;
      color?: string;
      dash?: "solid" | "dash" | "dot";
    };
    color?: string;
    visible?: boolean;
  }

  export interface AxisOptions {
    type: "value";
    name?: string;
    inside?: boolean;
    min?: number;
    max?: number;
    tickFormatter?: (value: number) => string | null;
  }

  export interface ChartGPUOptions {
    theme?: "dark" | "light" | Record<string, unknown>;
    palette?: readonly string[];
    animation?: boolean;
    renderMode?: "internal" | "external";
    tooltip?: { show: boolean };
    legend?: { show: boolean };
    performance?: { lod: "auto" | "strict" };
    grid?: { left: number; right: number; top: number; bottom: number };
    gridLines?: { show?: boolean; color?: string };
    xAxis?: AxisOptions;
    yAxis?: AxisOptions;
    series: readonly LineSeriesConfig[];
  }

  export interface ChartGPUInstance {
    readonly options: Readonly<ChartGPUOptions>;
    readonly disposed: boolean;
    setOption(options: ChartGPUOptions): void;
    setViewRange(range: {
      x: { min: number; max: number };
      y: { min: number; max: number };
    }): void;
    needsRender(): boolean;
    renderFrame(): boolean;
    resize(): void;
    dispose(): void;
  }

  export interface SharedGpuContext {
    adapter: GPUAdapter;
    device: GPUDevice;
    pipelineCache?: unknown;
  }

  export const ChartGPU: {
    create(
      container: HTMLElement,
      options: ChartGPUOptions,
      context?: SharedGpuContext,
    ): Promise<ChartGPUInstance>;
  };
  export function createPipelineCache(device: GPUDevice): unknown;
}
