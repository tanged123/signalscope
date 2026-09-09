import { expect, gotoApp, test } from "./fixtures";

test("settings palettes support keyboard access, custom editing, cancellation and reset", async ({
  page,
}) => {
  await gotoApp(page);
  await page.keyboard.press("Control+Comma");
  await page.locator(".palette-input").fill("Color palette");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", {
    name: "Color palette",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("combobox", { name: "Preset" })
    .selectOption("tol_contrast");
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--series-1")
          .trim(),
      ),
    )
    .toBe("#004488");

  await page.keyboard.press("Control+Comma");
  await page.locator(".palette-input").fill("Color palette");
  await page.keyboard.press("Enter");
  await dialog.getByRole("combobox", { name: "Preset" }).selectOption("custom");
  await dialog
    .getByRole("textbox", { name: "Color 1 hex", exact: true })
    .fill("#ff00ff");
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--series-1")
          .trim(),
      ),
    )
    .toBe("#ff00ff");

  await page.keyboard.press("Control+Comma");
  await page.locator(".palette-input").fill("Contour palette");
  await page.keyboard.press("Enter");
  const contour = page.getByRole("dialog", {
    name: "Contour palette",
    exact: true,
  });
  await contour.getByRole("combobox", { name: "Preset" }).selectOption("gray");
  await contour.getByRole("checkbox", { name: "Reverse" }).check();
  await contour.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(contour).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(
            getComputedStyle(document.documentElement).getPropertyValue(
              "--plot-contour-palette",
            ),
          ) as unknown,
      ),
    )
    .toEqual([
      { position: 0, color: "#ffffff" },
      { position: 1, color: "#000000" },
    ]);

  await page.keyboard.press("Control+Comma");
  await page.locator(".palette-input").fill("Color palette");
  await page.keyboard.press("Enter");
  await dialog.getByRole("combobox", { name: "Preset" }).selectOption("matlab");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--series-1")
          .trim(),
      ),
    )
    .toBe("#ff00ff");
  await expect(page.locator(".menu-button")).toBeFocused();
  await page.keyboard.press("Control+Comma");
  await page.locator(".palette-input").fill("Reset appearance");
  await page.keyboard.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--series-1")
          .trim(),
      ),
    )
    .toBe("#0072bd");
});
