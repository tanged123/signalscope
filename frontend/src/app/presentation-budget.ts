const TARGET_BINS_PER_PIXEL = 2 as const;
export const CPU_BYTES_PER_BIN = 121;
export const GPU_BYTES_PER_BIN = 96;
export const CPU_BYTES_PER_LINE2D_VALUE = 8;
export const GPU_BYTES_PER_LINE2D_VALUE = 4;
export const MIB = 1024 * 1024;

const MIN_CPU_BUDGET = 512 * MIB;
const MAX_CPU_BUDGET = 2 * 1024 * MIB;
const MIN_GPU_BUDGET = 256 * MIB;
const MAX_GPU_BUDGET = 1024 * MIB;

export interface PresentationBudgets {
  cpuBytes: number;
  gpuBytes: number;
}

export interface PanelDemand {
  panelId: string;
  physicalPixels: number;
  paddingRatio: number;
  visibleSeries: number;
  /** Worst-case response rows emitted for one reducer bin. */
  reductionExpansion: number;
  /** CPU bytes charged for each family-specific resource unit. */
  cpuBytesPerUnit?: number;
  /** GPU bytes charged for each family-specific resource unit. */
  gpuBytesPerUnit?: number;
}

export interface DensityPlan {
  density: number;
  targetDensity: 2;
  limited: boolean;
  fits: boolean;
  requests: ReadonlyMap<string, number>;
  estimatedCpuBytes: number;
  estimatedGpuBytes: number;
}

export function autoPresentationBudgets(
  adapterMaxBufferSize: number,
  deviceMemoryGiB?: number,
): PresentationBudgets {
  const cpuSource =
    typeof deviceMemoryGiB === "number" &&
    Number.isFinite(deviceMemoryGiB) &&
    deviceMemoryGiB > 0
      ? deviceMemoryGiB * 128 * MIB
      : MIN_CPU_BUDGET;
  const gpuSource =
    Number.isFinite(adapterMaxBufferSize) && adapterMaxBufferSize > 0
      ? adapterMaxBufferSize * 2
      : MIN_GPU_BUDGET;
  return {
    cpuBytes: clamp(cpuSource, MIN_CPU_BUDGET, MAX_CPU_BUDGET),
    gpuBytes: clamp(gpuSource, MIN_GPU_BUDGET, MAX_GPU_BUDGET),
  };
}

export function planPresentationDensity(input: {
  demands: readonly PanelDemand[];
  budgets: PresentationBudgets;
  retainedCpuBytes: number;
  retainedGpuBytes: number;
  maxDensity?: number;
}): DensityPlan {
  const targetDensity = Math.min(
    TARGET_BINS_PER_PIXEL,
    positiveOr(input.maxDensity, TARGET_BINS_PER_PIXEL),
  );
  const demands = input.demands.map(normalizeDemand);
  const retainedCpuBytes = nonNegativeFinite(input.retainedCpuBytes);
  const retainedGpuBytes = nonNegativeFinite(input.retainedGpuBytes);
  const minimumDensity = demands.reduce(
    (minimum, demand) =>
      Math.max(
        minimum,
        TARGET_BINS_PER_PIXEL / (demand.physicalPixels * demand.paddingRatio),
      ),
    0,
  );

  const evaluate = (density: number): EvaluatedDensity => {
    const requests = new Map<string, number>();
    let estimatedCpuBytes = retainedCpuBytes;
    let estimatedGpuBytes = retainedGpuBytes;
    for (const demand of demands) {
      const request = requestPixels(demand, density);
      requests.set(demand.panelId, request);
      const resourceUnits =
        2 * request * demand.visibleSeries * demand.reductionExpansion;
      estimatedCpuBytes +=
        resourceUnits * (demand.cpuBytesPerUnit ?? CPU_BYTES_PER_BIN);
      estimatedGpuBytes +=
        resourceUnits * (demand.gpuBytesPerUnit ?? GPU_BYTES_PER_BIN);
    }
    return {
      requests,
      estimatedCpuBytes,
      estimatedGpuBytes,
    };
  };
  const fits = (evaluated: EvaluatedDensity): boolean =>
    evaluated.estimatedCpuBytes <= input.budgets.cpuBytes &&
    evaluated.estimatedGpuBytes <= input.budgets.gpuBytes;

  if (demands.length === 0) {
    return makePlan(targetDensity, evaluate(targetDensity), true, false);
  }

  const preferred = evaluate(targetDensity);
  if (fits(preferred)) {
    return makePlan(
      targetDensity,
      preferred,
      true,
      targetDensity < TARGET_BINS_PER_PIXEL,
    );
  }

  const minimum = evaluate(minimumDensity);
  if (!fits(minimum)) {
    return makePlan(minimumDensity, minimum, false, true);
  }

  let low = minimumDensity;
  let high = targetDensity;
  let best = minimum;
  for (let iteration = 0; iteration < 32; iteration += 1) {
    const middle = (low + high) / 2;
    const evaluated = evaluate(middle);
    if (fits(evaluated)) {
      low = middle;
      best = evaluated;
    } else {
      high = middle;
    }
  }
  return makePlan(low, best, true, low < TARGET_BINS_PER_PIXEL);
}

interface EvaluatedDensity {
  requests: Map<string, number>;
  estimatedCpuBytes: number;
  estimatedGpuBytes: number;
}

function makePlan(
  density: number,
  evaluated: EvaluatedDensity,
  fits: boolean,
  limited: boolean,
): DensityPlan {
  return {
    density,
    targetDensity: TARGET_BINS_PER_PIXEL,
    limited,
    fits,
    requests: evaluated.requests,
    estimatedCpuBytes: evaluated.estimatedCpuBytes,
    estimatedGpuBytes: evaluated.estimatedGpuBytes,
  };
}

function normalizeDemand(demand: PanelDemand): PanelDemand {
  return {
    ...demand,
    physicalPixels: positiveOr(demand.physicalPixels, 1),
    paddingRatio: positiveOr(demand.paddingRatio, 1),
    visibleSeries: Math.max(
      0,
      Math.ceil(nonNegativeFinite(demand.visibleSeries)),
    ),
    reductionExpansion: positiveOr(demand.reductionExpansion, 1),
    cpuBytesPerUnit: positiveOr(demand.cpuBytesPerUnit, CPU_BYTES_PER_BIN),
    gpuBytesPerUnit: positiveOr(demand.gpuBytesPerUnit, GPU_BYTES_PER_BIN),
  };
}

function requestPixels(demand: PanelDemand, density: number): number {
  return Math.max(
    1,
    Math.ceil(
      (demand.physicalPixels * demand.paddingRatio * density) /
        TARGET_BINS_PER_PIXEL,
    ),
  );
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function nonNegativeFinite(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
