import { describe, expect, it } from "vitest";
import config from "../../playwright.config";

const softwareFlags = /swiftshader|use-webgpu-adapter/i;

function argsFor(
  project: NonNullable<typeof config.projects>[number],
): string[] {
  const args = project.use?.launchOptions?.args;
  return Array.isArray(args) ? args : [];
}

describe("Playwright GPU project flags", () => {
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
});
