import { defineConfig, devices } from "@playwright/test";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const coverage = process.env.SIGNALSCOPE_COVERAGE === "1";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  // GitHub's SwiftShader WebGPU adapter is not available to two browser
  // processes reliably; local hardware remains parallel.
  workers: process.env.CI ? 1 : undefined,
  // SwiftShader can briefly reject a context while the preceding test's GPU
  // device is being released. Retry the isolated test with a fresh context.
  retries: process.env.CI ? 2 : 0,
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
        "--use-gpu-in-tests",
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
