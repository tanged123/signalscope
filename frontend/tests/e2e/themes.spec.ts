import { expect, gotoApp, test } from "./fixtures";

test("named theme selection and T cycling preserve plot colors", async ({
  page,
}) => {
  await gotoApp(page);
  const root = page.locator("html");
  const color = await root.evaluate((element) =>
    getComputedStyle(element).getPropertyValue("--series-1"),
  );
  await page.keyboard.press("Control+Comma");
  await page.locator(".palette-input").fill("Theme");
  await page.keyboard.press("Enter");
  const picker = page.getByRole("dialog", { name: "Theme", exact: true });
  await expect(
    picker.getByRole("button", { name: "Dark", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await picker.getByRole("button", { name: "Graphite", exact: true }).click();
  await expect(picker).toHaveCount(0);
  await expect(root).toHaveAttribute("data-theme", "graphite");
  await expect(root).toHaveCSS("color-scheme", "dark");
  for (const theme of [
    "paper",
    "contrast_dark",
    "contrast_light",
    "dark",
    "light",
    "graphite",
  ]) {
    await page.keyboard.press("t");
    await expect(root).toHaveAttribute("data-theme", theme);
    expect(
      await root.evaluate((element) =>
        getComputedStyle(element).getPropertyValue("--series-1"),
      ),
    ).toBe(color);
  }
  await expect(page.locator(".gpu-warning")).toBeHidden();
});
