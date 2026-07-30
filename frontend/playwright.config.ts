import { defineConfig, devices } from "@playwright/test";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const coverage = process.env.SIGNALSCOPE_COVERAGE === "1";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  metadata: {
    coverage,
  },
  reporter: coverage
    ? [
        ["list"],
        [
          "json",
          {
            outputFile: "../build/coverage/frontend/playwright.json",
          },
        ],
      ]
    : "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    headless: true,
    trace: "retain-on-failure",
    ...(executablePath === undefined
      ? {}
      : { launchOptions: { executablePath } }),
  },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm dev",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
  },
});
