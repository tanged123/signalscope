import gridShader from "./shaders/grid.wgsl?raw";
import indirectArgsShader from "./shaders/indirect-args.wgsl?raw";
import hairlineShader from "./shaders/line-hairline.wgsl?raw";
import quadShader from "./shaders/line-quad.wgsl?raw";
import pickReduceShader from "./shaders/pick-reduce.wgsl?raw";
import pickSeriesShader from "./shaders/pick-series.wgsl?raw";
import scanAddShader from "./shaders/scan-add.wgsl?raw";
import scanBlocksShader from "./shaders/scan-blocks.wgsl?raw";
import segmentFlagsShader from "./shaders/segment-flags.wgsl?raw";
import segmentScatterShader from "./shaders/segment-scatter.wgsl?raw";

export interface ProductionShader {
  readonly label: string;
  readonly code: string;
}

export const PRODUCTION_SHADERS: readonly ProductionShader[] = Object.freeze([
  { label: "grid", code: gridShader },
  { label: "line-quad", code: quadShader },
  { label: "line-hairline", code: hairlineShader },
  { label: "segment-flags", code: segmentFlagsShader },
  { label: "scan-blocks", code: scanBlocksShader },
  { label: "scan-add", code: scanAddShader },
  { label: "segment-scatter", code: segmentScatterShader },
  { label: "indirect-args", code: indirectArgsShader },
  { label: "pick-series", code: pickSeriesShader },
  { label: "pick-reduce", code: pickReduceShader },
]);

export async function compileProductionShaders(
  device: GPUDevice,
): Promise<readonly string[]> {
  const errors: string[] = [];
  for (const shader of PRODUCTION_SHADERS) {
    const module = device.createShaderModule({
      label: shader.label,
      code: shader.code,
    });
    if (typeof module.getCompilationInfo !== "function") continue;
    try {
      const info = await module.getCompilationInfo();
      for (const message of info.messages) {
        if (message.type === "error") {
          errors.push(`${shader.label}: ${message.message}`);
        }
      }
    } catch (error: unknown) {
      errors.push(
        `${shader.label}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return errors;
}
