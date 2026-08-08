export interface GpuMetricsSnapshot {
  readonly frameCount: number;
  readonly frameCpuMs: readonly number[];
  readonly uploadBytes: number;
  readonly residentBytes: number;
  readonly residentPages: number;
  readonly drawCalls: number;
  readonly submittedSegments: number;
  readonly selectedSeries: number;
  readonly visibleSeries: number;
  readonly seriesWithSegments: number;
  readonly compactSegments: number;
  readonly descriptorRebuilds: number;
  readonly successfulFrames: number;
  readonly validationErrors: readonly string[];
  readonly pickLatencyMs: readonly number[];
  readonly deviceRecoveryMs: readonly number[];
}

interface MetricsValue {
  frameCount: number;
  frameCpuMs: number[];
  uploadBytes: number;
  residentBytes: number;
  residentPages: number;
  drawCalls: number;
  submittedSegments: number;
  selectedSeries: number;
  visibleSeries: number;
  seriesWithSegments: number;
  compactSegments: number;
  descriptorRebuilds: number;
  successfulFrames: number;
  validationErrors: string[];
  pickLatencyMs: number[];
  deviceRecoveryMs: number[];
}

export class GpuMetrics {
  private value: MetricsValue = emptySnapshot();
  private readonly panelSeries = new Map<string, [number, number]>();

  recordFrame(durationMs: number): void {
    this.value.frameCount += 1;
    this.value.frameCpuMs.push(durationMs);
  }

  recordUpload(bytes: number): void {
    this.value.uploadBytes += bytes;
  }

  setResident(bytes: number, pages: number): void {
    this.value.residentBytes = bytes;
    this.value.residentPages = pages;
  }

  recordDraw(drawCalls: number): void {
    this.value.drawCalls += drawCalls;
  }

  recordCompactSegments(segments: number): void {
    this.value.submittedSegments += segments;
    this.value.compactSegments += segments;
  }

  setVisibleSeries(visibleSeries: number, seriesWithSegments: number): void {
    this.setPanelSeries("__default", visibleSeries, seriesWithSegments);
  }

  setPanelSeries(
    panelId: string,
    selectedSeries: number,
    seriesWithSegments: number,
  ): void {
    this.panelSeries.set(panelId, [selectedSeries, seriesWithSegments]);
    this.recomputeSeriesCounts();
  }

  removePanelSeries(panelId: string): void {
    if (!this.panelSeries.delete(panelId)) return;
    this.recomputeSeriesCounts();
  }

  recordSuccessfulFrame(): void {
    this.value.successfulFrames += 1;
  }

  recordValidationError(message: string): void {
    this.value.validationErrors.push(message);
  }

  recordDescriptorRebuild(): void {
    this.value.descriptorRebuilds += 1;
  }

  recordPickLatency(durationMs: number): void {
    this.value.pickLatencyMs.push(durationMs);
  }

  recordRecovery(durationMs: number): void {
    this.value.deviceRecoveryMs.push(durationMs);
  }

  snapshot(): GpuMetricsSnapshot {
    return {
      ...this.value,
      frameCpuMs: [...this.value.frameCpuMs],
      validationErrors: [...this.value.validationErrors],
      pickLatencyMs: [...this.value.pickLatencyMs],
      deviceRecoveryMs: [...this.value.deviceRecoveryMs],
    };
  }

  reset(): void {
    const residentBytes = this.value.residentBytes;
    const residentPages = this.value.residentPages;
    this.value = emptySnapshot();
    this.value.residentBytes = residentBytes;
    this.value.residentPages = residentPages;
  }

  private recomputeSeriesCounts(): void {
    this.value.selectedSeries = 0;
    this.value.visibleSeries = 0;
    this.value.seriesWithSegments = 0;
    for (const [selected, drawable] of this.panelSeries.values()) {
      this.value.selectedSeries += selected;
      this.value.visibleSeries += selected;
      this.value.seriesWithSegments += drawable;
    }
  }
}

function emptySnapshot(): MetricsValue {
  return {
    frameCount: 0,
    frameCpuMs: [],
    uploadBytes: 0,
    residentBytes: 0,
    residentPages: 0,
    drawCalls: 0,
    submittedSegments: 0,
    visibleSeries: 0,
    selectedSeries: 0,
    seriesWithSegments: 0,
    compactSegments: 0,
    descriptorRebuilds: 0,
    successfulFrames: 0,
    validationErrors: [],
    pickLatencyMs: [],
    deviceRecoveryMs: [],
  };
}
