import { expect, test as base, type Page } from "@playwright/test";

interface CoverageFixtures {
  collectCoverage: undefined;
}

export const test = base.extend<CoverageFixtures>({
  page: async ({ page }, use) => {
    const originalGoto = page.goto.bind(page);
    page.goto = async (...args: Parameters<Page["goto"]>) => {
      const response = await originalGoto(...args);
      if (new URL(page.url()).pathname === "/") {
        await page.locator(".panel").first().waitFor({
          state: "visible",
          timeout: 120_000,
        });
      }
      return response;
    };
    await use(page);
  },
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

export { expect };
