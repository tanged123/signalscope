import type { DensityPlan } from "../app/presentation-budget";
import { formatBytes, required } from "./dom";

export function statusAggregate(
  sources: number,
  signals: number,
  points: number,
): string {
  return `${sources.toLocaleString()} ${sources === 1 ? "source" : "sources"} · ${signals.toLocaleString()} ${signals === 1 ? "signal" : "signals"} · ${new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(points)} points`;
}

export function renderDockFooter(
  container: HTMLElement,
  onAddSource: () => void,
): void {
  const add = document.createElement("button");
  add.className = "dock-add-source";
  add.type = "button";
  add.textContent = "+ source";
  add.addEventListener("click", onAddSource);
  container.replaceChildren(add);
}

export function formatPresentationStatus(
  plan: Pick<DensityPlan, "density" | "targetDensity" | "limited" | "fits">,
): string {
  if (!plan.fits) return "Memory constrained";
  return plan.limited ? "Reduced resolution" : "";
}

export function renderPresentationStatus(
  root: HTMLElement,
  plan: DensityPlan,
): void {
  const status = required<HTMLElement>(root, ".presentation-status");
  status.textContent = formatPresentationStatus(plan);
  status.hidden = status.textContent.length === 0;
  required(root, ".performance-cpu").textContent = formatBytes(
    plan.estimatedCpuBytes,
  );
  required(root, ".performance-gpu").textContent = formatBytes(
    plan.estimatedGpuBytes,
  );
  required(root, ".performance-density").textContent =
    `${plan.density.toFixed(2)}/${String(plan.targetDensity)}`;
}

export function performanceMarkup(): string {
  return `<span class="performance-metrics" role="group" aria-label="Chart performance">
    <span title="Last CPU chart update, excluding data queries and GPU execution.">Chart update <span class="render-ms">— ms</span></span>
    <span title="Estimated CPU memory for active workspace charts, including retained data and the planned update. Not total process memory or utilization.">CPU est. <span class="performance-cpu">—</span></span>
    <span title="Estimated GPU memory for active workspace charts, including the planned update. Not total GPU memory or utilization.">GPU est. <span class="performance-gpu">—</span></span>
    <span title="Resolution / target, in bins per physical device pixel.">Res. <span class="performance-density">—</span></span>
    <span class="presentation-status" hidden></span>
  </span>`;
}
