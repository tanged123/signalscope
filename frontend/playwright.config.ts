import { defineConfig, devices } from "@playwright/test";
import {
  browserWebGpuArgs,
  softwareWebGpuArgs,
} from "./src/render/gpu/playwright-projects";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const coverage = process.env.SIGNALSCOPE_COVERAGE === "1";
const webGpuLaunchOptions = {
  ...(executablePath === undefined ? {} : { executablePath }),
  args: [...browserWebGpuArgs],
};
const softwareWebGpuLaunchOptions = {
  ...(executablePath === undefined ? {} : { executablePath }),
  args: [...softwareWebGpuArgs],
};

export type PlaywrightServerMode = "managed" | "none";

export function playwrightServerMode(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): PlaywrightServerMode {
  const mode = environment.SIGNALSCOPE_PLAYWRIGHT_WEB_SERVER ?? "managed";
  if (mode !== "managed" && mode !== "none") {
    throw new Error(
      `SIGNALSCOPE_PLAYWRIGHT_WEB_SERVER must be managed or none, got ${mode}`,
    );
  }
  return mode;
}

export function playwrightWebServer(
  mode: PlaywrightServerMode,
): { command: string; url: string; reuseExistingServer: false } | undefined {
  return mode === "managed"
    ? {
        command: "pnpm dev",
        url: "http://127.0.0.1:4173",
        reuseExistingServer: false,
      }
    : undefined;
}

const webServer = playwrightWebServer(playwrightServerMode());

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  workers: 1,
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
    launchOptions: webGpuLaunchOptions,
  },
  projects: [
    {
      name: "desktop",
      testIgnore: /electron-.*\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: webGpuLaunchOptions,
      },
    },
    {
      name: "demo",
      testDir: "./tests/demo",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
        launchOptions: webGpuLaunchOptions,
        video: { mode: "on", size: { width: 1280, height: 800 } },
      },
      outputDir: "../build/demo/recording",
    },
    {
      name: "gpu",
      testDir: "./tests/gpu",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1000, height: 600 },
        launchOptions: softwareWebGpuLaunchOptions,
      },
    },
    {
      name: "bench-software",
      testDir: "./tests/bench",
      testMatch: /software-smoke\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
        launchOptions: softwareWebGpuLaunchOptions,
      },
    },
    {
      name: "electron-native",
      testDir: "./tests/e2e",
      testMatch: /electron-native(?:-export)?\.spec\.ts/,
    },
    {
      name: "electron-packaged",
      testDir: "./tests/e2e",
      testMatch: /electron-packaged\.spec\.ts/,
    },
    {
      name: "electron-hardware",
      testDir: "./tests/bench",
      testMatch: /electron-hardware\.spec\.ts/,
      use: { launchOptions: { args: [] } },
    },
  ],
  ...(webServer === undefined ? {} : { webServer }),
});
