import { defineConfig, devices } from "@playwright/test";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const lineGpu = process.env.SIGNALSCOPE_LINE_GPU_BENCH === "1";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  // GitHub's SwiftShader WebGPU adapter is not available to two browser
  // processes reliably; local hardware remains parallel.
  workers: process.env.CI ? 1 : undefined,
  // SwiftShader can briefly reject a context while the preceding test's GPU
  // device is being released. Retry the isolated test with a fresh context.
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    headless: true,
    actionTimeout: 15_000,
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
    {
      name: "desktop",
      testIgnore: /electron-packaged\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "electron-packaged",
      testMatch: /electron-packaged\.spec\.ts/,
    },
    {
      name: "bench",
      testDir: "./tests/bench",
      // The line-strip fixture needs Vite; run it via `./scripts/test.sh bench line-gpu`.
      testIgnore: lineGpu ? undefined : /line-strip\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: "http://127.0.0.1:4173",
        viewport: { width: 1280, height: 800 },
      },
    },
  ],
  // Only the line-strip GPU fixture is served by Vite; journeys run the
  // built app from scope-server and benches open baked snapshots.
  webServer: lineGpu
    ? {
        command: "pnpm dev",
        url: "http://127.0.0.1:4173",
        reuseExistingServer: !process.env.CI,
      }
    : undefined,
});
