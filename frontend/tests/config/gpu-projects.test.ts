import { describe, expect, it } from "vitest";
import config, {
  playwrightServerMode,
  playwrightWebServer,
} from "../../playwright.config";

const softwareFlags = /swiftshader|use-webgpu-adapter/i;

function argsFor(
  project: NonNullable<typeof config.projects>[number],
): string[] {
  const args = project.use?.launchOptions?.args;
  return Array.isArray(args) ? args : [];
}

describe("Playwright GPU project flags", () => {
  it("keeps native-only specs out of the browser desktop project", () => {
    const project = config.projects?.find(
      (candidate) => candidate.name === "desktop",
    );
    if (project === undefined) throw new Error("desktop project missing");
    expect(project.testIgnore).toEqual(/electron-.*\.spec\.ts/);
  });

  it("restricts software flags to bounded software projects", () => {
    const projects = config.projects ?? [];
    const software = new Set(["gpu", "bench-software"]);
    for (const project of projects) {
      const hasSoftwareFlag = argsFor(project).some((arg) =>
        softwareFlags.test(arg),
      );
      expect(hasSoftwareFlag).toBe(software.has(project.name ?? ""));
    }
  });

  it("leaves the Electron hardware benchmark on normal Chromium defaults", () => {
    const project = config.projects?.find(
      (candidate) => candidate.name === "electron-hardware",
    );
    if (project === undefined)
      throw new Error("electron-hardware project missing");
    expect(argsFor(project)).toEqual([]);
  });

  it("assigns exactly one Playwright server in managed mode", () => {
    expect(playwrightWebServer("managed")).toEqual({
      command: "pnpm dev",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: false,
    });
  });

  it("does not configure a server in file or app mode", () => {
    expect(playwrightWebServer("none")).toBeUndefined();
  });

  it("rejects an unknown server mode", () => {
    expect(() =>
      playwrightServerMode({
        SIGNALSCOPE_PLAYWRIGHT_WEB_SERVER: "reuse",
      }),
    ).toThrow(/SIGNALSCOPE_PLAYWRIGHT_WEB_SERVER/);
  });

  it("does not infer ownership from CI, benchmark, demo, or package flags", () => {
    const environment = {
      SIGNALSCOPE_PLAYWRIGHT_WEB_SERVER: "managed",
      CI: "1",
      SIGNALSCOPE_BENCH: "1",
      SIGNALSCOPE_DEMO: "1",
      SIGNALSCOPE_PACKAGE_SMOKE: "1",
    };
    expect(playwrightServerMode(environment)).toBe("managed");
    expect(playwrightWebServer(playwrightServerMode(environment))).toEqual(
      playwrightWebServer("managed"),
    );
  });
});
