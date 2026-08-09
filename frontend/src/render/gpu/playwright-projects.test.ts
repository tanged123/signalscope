import { describe, expect, it } from "vitest";
import { browserWebGpuArgs, softwareWebGpuArgs } from "./playwright-projects";

describe("Playwright GPU launch policy", () => {
  it("keeps software-adapter flags out of normal browser projects", () => {
    expect(browserWebGpuArgs).not.toContain("--use-angle=swiftshader");
    expect(browserWebGpuArgs).not.toContain("--use-webgpu-adapter=swiftshader");
  });

  it("bounds software rendering to the explicit software project", () => {
    expect(softwareWebGpuArgs).toEqual(
      expect.arrayContaining([
        "--use-angle=swiftshader",
        "--use-webgpu-adapter=swiftshader",
      ]),
    );
  });
});
