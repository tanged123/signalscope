import { defineConfig, devices } from "@playwright/test";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    headless: true,
    trace: "retain-on-failure",
    ...(executablePath === undefined
      ? {}
      : { launchOptions: { executablePath } }),
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-review", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "pnpm dev",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
  },
});
