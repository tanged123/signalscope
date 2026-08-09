import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "../e2e/fixtures";
import { gpuMetrics, waitForSuccessfulFrame } from "./measure";

const artifact = new URL(
  "../../../build/bench/smoke.html?signalscope-bench=1",
  import.meta.url,
);
const reportDir = new URL("../../../build/bench/report/", import.meta.url);

test("software adapter completes the bounded renderer smoke", async ({
  page,
}) => {
  test.setTimeout(120_000);
  expect(existsSync(fileURLToPath(artifact))).toBe(true);
  await page.goto(artifact.href);
  await expect(page.locator(".series-canvas").first()).toBeVisible({
    timeout: 60_000,
  });
  const firstFrame = await waitForSuccessfulFrame(page);
  const metrics = await gpuMetrics(page);
  const pass =
    firstFrame > 0 &&
    metrics.successfulFrames > 0 &&
    metrics.validationErrors.length === 0;
  mkdirSync(fileURLToPath(reportDir), { recursive: true });
  writeFileSync(
    new URL("software_smoke.json", reportDir),
    `${JSON.stringify(
      {
        bench: "software_smoke",
        adapter: "swiftshader",
        first_frame_ms: firstFrame,
        successful_frames: metrics.successfulFrames,
        validation_errors: metrics.validationErrors.length,
        pass,
      },
      null,
      2,
    )}\n`,
  );
  expect(metrics.successfulFrames).toBeGreaterThan(0);
  expect(metrics.validationErrors).toEqual([]);
});
