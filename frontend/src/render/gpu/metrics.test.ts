import { describe, expect, it } from "vitest";
import { GpuMetrics } from "./metrics";

describe("GpuMetrics", () => {
  it("accumulates counters and returns defensive snapshots", () => {
    const metrics = new GpuMetrics();
    metrics.recordFrame(4);
    metrics.recordUpload(128);
    metrics.setResident(512, 2);
    metrics.recordDraw(3);
    metrics.recordSegments(983);
    metrics.setVisibleSeries(1000, 983);
    metrics.recordDescriptorRebuild();
    metrics.recordPickLatency(2);
    metrics.recordRecovery(8);
    const snapshot = metrics.snapshot();
    snapshot.frameCpuMs.push(99);
    expect(metrics.snapshot()).toMatchObject({
      frameCount: 1,
      frameCpuMs: [4],
      uploadBytes: 128,
      residentBytes: 512,
      residentPages: 2,
      drawCalls: 3,
      submittedSegments: 983,
      visibleSeries: 1000,
      seriesWithSegments: 983,
      descriptorRebuilds: 1,
      pickLatencyMs: [2],
      deviceRecoveryMs: [8],
    });
  });

  it("resets interval counters while retaining current residency", () => {
    const metrics = new GpuMetrics();
    metrics.setResident(1024, 4);
    metrics.recordFrame(7);
    metrics.recordUpload(64);
    metrics.reset();
    expect(metrics.snapshot()).toMatchObject({
      frameCount: 0,
      frameCpuMs: [],
      uploadBytes: 0,
      residentBytes: 1024,
      residentPages: 4,
    });
  });

  it("counts drawable series independently from descriptor pages", () => {
    const metrics = new GpuMetrics();
    metrics.setVisibleSeries(1000, 983);
    metrics.recordDraw(2);
    expect(metrics.snapshot()).toMatchObject({
      visibleSeries: 1000,
      seriesWithSegments: 983,
      drawCalls: 2,
    });
  });
});
