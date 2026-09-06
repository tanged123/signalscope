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
  maxFailures: process.env.CI ? 1 : 0,
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
      // Enable headless GPU presentation and share SwANGLE’s Vulkan context
      // with the compositor; a separate GL/software path loses WebGPU images.
      args: [
        "--enable-unsafe-webgpu",
        "--enable-gpu",
        "--enable-features=Vulkan,VulkanFromANGLE",
        "--use-angle=swiftshader",
        "--disable-vulkan-surface",
        "--use-webgpu-adapter=swiftshader",
      ],
      ...(executablePath === undefined ? {} : { executablePath }),
    },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "electron-packaged",
      testMatch: /electron-packaged\.spec\.ts/,
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
    process.env.SIGNALSCOPE_BENCH === "1" ||
    process.env.SIGNALSCOPE_PACKAGE_SMOKE === "1"
      ? undefined
      : {
          command: "pnpm dev",
          url: "http://127.0.0.1:4173",
          reuseExistingServer: !process.env.CI,
        },
});
