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
    launchOptions: {
      args: [
        "--enable-unsafe-webgpu",
        "--enable-features=Vulkan",
        "--use-angle=swiftshader",
        "--use-webgpu-adapter=swiftshader",
      ],
      ...(executablePath === undefined ? {} : { executablePath }),
    },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "demo",
      testDir: "./tests/demo",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
        video: { mode: "on", size: { width: 1280, height: 800 } },
      },
      outputDir: "../build/demo/recording",
    },
    {
      name: "bench",
      testDir: "./tests/bench",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
      },
    },
  ],
  webServer:
    process.env.SIGNALSCOPE_DEMO === "1" ||
    process.env.SIGNALSCOPE_BENCH === "1"
      ? undefined
      : {
          command: "pnpm dev",
          url: "http://127.0.0.1:4173",
          reuseExistingServer: !process.env.CI,
        },
});
