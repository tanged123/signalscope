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
    `${plan.density.toFixed(2)} / ${String(plan.targetDensity)} bins per device pixel`;
}

export function performanceMarkup(): string {
  return `<details class="performance-details">
    <summary title="Chart performance details">Chart update <span class="render-ms">— ms</span><span class="presentation-status" hidden></span></summary>
    <div class="performance-popover">
      <strong>Active workspace charts</strong>
      <p>Last CPU chart update, excluding data queries and GPU execution.</p>
      <dl><dt>Estimated CPU memory</dt><dd class="performance-cpu">—</dd>
        <dt>Estimated GPU memory</dt><dd class="performance-gpu">—</dd>
        <dt>Resolution / target</dt><dd class="performance-density">—</dd></dl>
      <p>Memory estimates include retained data and the planned update. They are not total process memory or CPU/GPU utilization.</p>
    </div>
  </details>`;
}
