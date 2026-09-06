import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "./fixtures";

interface LineStripResult {
  comparisons: number;
  changedBytes: number;
  paintedPixels: number;
  timings: {
    sampleCount: number;
    colored: boolean;
    referenceMs: number;
    stripMs: number;
  }[];
  adapter: { vendor: string; architecture: string; description: string };
}

test("line strips preserve triangle-list pixels, gaps, colors and dash coverage", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/tests/e2e/fixtures/line-strip.html");
  const result = await page.evaluate((measure) => {
    const fixture = window as unknown as {
      runLineStrip(measure: boolean): Promise<LineStripResult>;
    };
    return fixture.runLineStrip(measure);
  }, process.env.SIGNALSCOPE_LINE_GPU_BENCH === "1");
  if (process.env.SIGNALSCOPE_LINE_GPU_BENCH === "1") {
    const reportDir = new URL("../../../build/bench/report/", import.meta.url);
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(
      new URL("line_strip.json", reportDir),
      JSON.stringify(
        { bench: "line_strip", segments: 99_999, ...result },
        null,
        2,
      ),
    );
    expect(result.timings).toHaveLength(4);
  } else {
    expect(result.comparisons).toBe(24);
    expect(result.paintedPixels).toBeGreaterThan(1_000);
    expect(result.changedBytes).toBe(0);
  }
});
