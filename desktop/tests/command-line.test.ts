import { describe, expect, it, vi } from "vitest";
import { configureCommandLine } from "../src/command-line";

describe("Electron command line", () => {
  it("enables WebGPU on Linux", () => {
    const appendSwitch = vi.fn();
    configureCommandLine({ appendSwitch }, "linux");
    expect(appendSwitch).toHaveBeenCalledWith("enable-unsafe-webgpu");
  });

  it.each(["darwin", "win32"] as const)(
    "does not bypass WebGPU safeguards on %s",
    (platform) => {
      const appendSwitch = vi.fn();
      configureCommandLine({ appendSwitch }, platform);
      expect(appendSwitch).not.toHaveBeenCalledWith("enable-unsafe-webgpu");
    },
  );
});
