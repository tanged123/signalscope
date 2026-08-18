import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { interact, startFrameProbe, stopFrameProbe } from "../bench/measure";
import { expect, test } from "./fixtures";

const artifact = new URL("../../../build/bench/smoke.html", import.meta.url);

test("bench smoke: baked monte-carlo workspace renders and survives interaction", async ({
  page,
}) => {
  expect(
    existsSync(fileURLToPath(artifact)),
    "bake_bench_smoke_artifact must run first",
  ).toBe(true);
  await page.goto(artifact.href);
  await expect(page.locator(".chart-host canvas").first()).toBeVisible();
  await expect(page.locator(".render-ms")).not.toHaveText("— ms");
  const readout = page.locator(".window-readout").first();
  const before = await readout.textContent();
  await startFrameProbe(page);
  await interact(page);
  const stats = await stopFrameProbe(page);
  expect(stats.frames).toBeGreaterThan(0);
  await expect(readout).not.toHaveText(before ?? "");
});
