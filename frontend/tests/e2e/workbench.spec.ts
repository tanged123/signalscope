import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, openWorkbench, pageErrors, test, writeRun } from "./fixtures";
import { compareFrames, installPlotReadback, plotFrame } from "./plot-pixels";

async function ink(page: Page, target: Locator): Promise<number> {
  const frame = await plotFrame(target);
  if (frame === null) return 0;
  return (await compareFrames(page, frame, frame)).inkA;
}

async function importRun(page: Page) {
  await page.getByRole("button", { name: "+ source" }).click();
  await expect(
    page
      .getByRole("complementary", { name: "Signals" })
      .getByRole("row", { name: "a", exact: true }),
  ).toBeVisible({ timeout: 60_000 });
}

async function dragSignal(page: Page, channel: string, target: Locator) {
  const row = page
    .getByRole("complementary", { name: "Signals" })
    .getByRole("row", { name: channel, exact: true });
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await row.dispatchEvent("dragstart", { dataTransfer: transfer });
  await target.dispatchEvent("dragover", { dataTransfer: transfer });
  await target.dispatchEvent("drop", { dataTransfer: transfer });
}

test("import, plot, zoom, undo and reopen a session", async ({
  page,
  server,
}) => {
  test.setTimeout(180_000);
  writeRun(join(server.dialogs, "run.csv"), 5_000);
  const errors = pageErrors(page);
  await installPlotReadback(page);
  await openWorkbench(page, server.url);

  await importRun(page);

  await page.keyboard.press("n");
  const plot = page.getByRole("article").first();
  await dragSignal(page, "a", plot);
  await expect
    .poll(() => ink(page, plot), { timeout: 30_000 })
    .toBeGreaterThan(300);

  const window = page.getByText(/^window /);
  const fitted = await window.textContent();
  const box = await plot.boundingBox();
  if (box === null) throw new Error("plot is not laid out");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -400);
  await expect(window).not.toHaveText(fitted ?? "");
  const zoomed = await window.textContent();

  await page.keyboard.press("ControlOrMeta+z");
  await expect(window).toHaveText(fitted ?? "");
  const saved = page.waitForResponse(
    (response) => response.url().includes("save_session") && response.ok(),
  );
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(window).toHaveText(zoomed ?? "");
  await saved;
  await page.reload();
  await expect(page.locator("#app")).toHaveAttribute("data-ready", "true");
  await expect(page.getByText(/^window /)).toHaveText(zoomed ?? "");
  const restored = page.getByRole("article").first();
  await expect
    .poll(() => ink(page, restored), { timeout: 30_000 })
    .toBeGreaterThan(300);
  expect(errors).toEqual([]);
});

test("new panels of each type plot the signals assigned to them", async ({
  page,
  server,
}) => {
  test.setTimeout(180_000);
  writeRun(join(server.dialogs, "run.csv"), 5_000);
  const errors = pageErrors(page);
  await installPlotReadback(page);
  await openWorkbench(page, server.url);
  await importRun(page);

  const panels = page.getByRole("article");
  for (const [index, type] of ["2D line", "Scatter", "Histogram"].entries()) {
    await page.keyboard.press("n");
    await expect(panels).toHaveCount(index + 1);
    await panels
      .nth(index)
      .getByRole("group", { name: "Panel type" })
      .getByRole("button", { name: new RegExp(`^${type}`) })
      .click();
  }
  for (let index = 0; index < 3; index += 1)
    await dragSignal(page, "a", panels.nth(index));
  for (let index = 0; index < 3; index += 1)
    await expect
      .poll(() => ink(page, panels.nth(index)), { timeout: 30_000 })
      .toBeGreaterThan(300);
  expect(errors).toEqual([]);
});
