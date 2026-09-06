import {
  devices,
  expect,
  test as base,
  type Page,
  type Locator,
} from "@playwright/test";

export async function openPlotSettings(panel: Locator): Promise<void> {
  const settings = panel.locator(".plot-settings");
  if (
    !(await settings.evaluate(
      (element) => (element as HTMLDetailsElement).open,
    ))
  ) {
    await settings.locator("summary").click();
  }
}

const testBase = base.extend({
  page: async ({ playwright }, use, testInfo) => {
    await new Promise<void>((resolve) => setTimeout(resolve, 1_500));
    const browser = await playwright.chromium.launch(
      testInfo.project.use.launchOptions,
    );
    const { defaultBrowserType, ...desktop } = devices["Desktop Chrome"];
    void defaultBrowserType;
    const baseURL = testInfo.project.use.baseURL;
    try {
      const context = await browser.newContext({
        ...desktop,
        viewport: testInfo.project.use.viewport ?? desktop.viewport,
        ...(baseURL === undefined ? {} : { baseURL }),
      });
      try {
        await use(await context.newPage());
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  },
});

interface CoverageFixtures {
  collectCoverage: undefined;
}

export const test = testBase.extend<CoverageFixtures>({
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
