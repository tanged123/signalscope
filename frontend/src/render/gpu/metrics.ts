export interface GpuMetricsSnapshot {
  frameCount: number;
  frameCpuMs: number[];
  uploadBytes: number;
  residentBytes: number;
  residentPages: number;
  drawCalls: number;
  submittedSegments: number;
  visibleSeries: number;
  seriesWithSegments: number;
  descriptorRebuilds: number;
  pickLatencyMs: number[];
  deviceRecoveryMs: number[];
}

export class GpuMetrics {
  private value: GpuMetricsSnapshot = emptySnapshot();

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

  recordSegments(segments: number): void {
    this.value.submittedSegments += segments;
  }

  setVisibleSeries(visibleSeries: number, seriesWithSegments: number): void {
    this.value.visibleSeries = visibleSeries;
    this.value.seriesWithSegments = seriesWithSegments;
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
}

function emptySnapshot(): GpuMetricsSnapshot {
  return {
    frameCount: 0,
    frameCpuMs: [],
    uploadBytes: 0,
    residentBytes: 0,
    residentPages: 0,
    drawCalls: 0,
    submittedSegments: 0,
    visibleSeries: 0,
    seriesWithSegments: 0,
    descriptorRebuilds: 0,
    pickLatencyMs: [],
    deviceRecoveryMs: [],
  };
}
