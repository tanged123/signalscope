export interface ScanDispatch {
  readonly kind: "scan-blocks" | "scan-block-sums" | "add-block-offsets";
  readonly values: number;
  readonly workgroups: number;
}

const VALUES_PER_WORKGROUP = 512;

export function exclusiveScan(values: readonly number[]): {
  values: number[];
  total: number;
} {
  const scanned: number[] = [];
  let total = 0;
  for (const value of values) {
    scanned.push(total);
    total += value;
  }
  return { values: scanned, total };
}

export function scanDispatchPlan(length: number): ScanDispatch[] {
  if (length <= 0) return [];
  const passes: ScanDispatch[] = [];
  let blocks = Math.ceil(length / VALUES_PER_WORKGROUP);
  passes.push({
    kind: "scan-blocks",
    values: length,
    workgroups: blocks,
  });
  while (blocks > 1) {
    const next = Math.ceil(blocks / VALUES_PER_WORKGROUP);
    passes.push({ kind: "scan-block-sums", values: blocks, workgroups: next });
    blocks = next;
  }
  passes.push({
    kind: "add-block-offsets",
    values: length,
    workgroups: Math.ceil(length / VALUES_PER_WORKGROUP),
  });
  return passes;
}

export class GpuPrefixScan {
  constructor(private readonly workgroupSize = 256) {}

  plan(length: number): ScanDispatch[] {
    void this.workgroupSize;
    return scanDispatchPlan(length);
  }

  encode(
    pass: GPUComputePassEncoder,
    length: number,
    workgroupSize = this.workgroupSize,
  ): void {
    for (const dispatch of scanDispatchPlan(length)) {
      pass.dispatchWorkgroups(Math.ceil(dispatch.values / (workgroupSize * 2)));
    }
  }
}
