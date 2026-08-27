import { expect, test as base, type Page } from "@playwright/test";

interface CoverageFixtures {
  collectCoverage: undefined;
}

export const test = base.extend<CoverageFixtures>({
  collectCoverage: [
    async ({ page }, use, testInfo) => {
      if (testInfo.config.metadata["coverage"] !== true) {
        await use(undefined);
        return;
      }

      await page.coverage.startJSCoverage({ resetOnNavigation: false });
      await use(undefined);
      const entries = await page.coverage.stopJSCoverage();
      const sourceEntries = entries.filter((entry) => {
        const path = new URL(entry.url).pathname;
        return (
          path.startsWith("/src/") &&
          path.endsWith(".ts") &&
          !path.startsWith("/src/generated/")
        );
      });
      await testInfo.attach("js-coverage", {
        body: JSON.stringify(sourceEntries),
        contentType: "application/json",
      });
    },
    { auto: true },
  ],
});

export async function gotoApp(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator("#app")).toHaveAttribute("data-ready", "true", {
    timeout: 20_000,
  });
}

export { expect };
