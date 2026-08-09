import { describe, expect, it } from "vitest";
import {
  desktopApplicationRoot,
  normalizeElectronArguments,
} from "../src/launcher";

describe("Electron application launcher", () => {
  it("resolves the desktop directory from the start script URL", () => {
    const startUrl = new URL("../scripts/start.mjs", import.meta.url).href;

    expect(desktopApplicationRoot(startUrl)).toBe(
      new URL("..", startUrl).pathname.replace(/\/$/, ""),
    );
    expect(desktopApplicationRoot(startUrl)).not.toBe(
      new URL("../..", startUrl).pathname.replace(/\/$/, ""),
    );
  });

  it("removes only a leading package-manager separator", () => {
    expect(
      normalizeElectronArguments(["--", "--open", "/tmp/run.csv"]),
    ).toEqual(["--open", "/tmp/run.csv"]);
    expect(normalizeElectronArguments(["--open", "/tmp/run.csv"])).toEqual([
      "--open",
      "/tmp/run.csv",
    ]);
  });
});
