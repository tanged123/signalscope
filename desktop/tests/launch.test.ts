import { describe, expect, it } from "vitest";
import { parseLaunchPaths } from "../src/launch";

describe("Electron launch paths", () => {
  it("accepts explicit file and folder open arguments", () => {
    expect(
      parseLaunchPaths(["--open", "/tmp/run.csv", "--open-folder=/tmp/runs"]),
    ).toEqual(["/tmp/run.csv", "/tmp/runs"]);
  });

  it("rejects missing or relative explicit paths", () => {
    expect(() => parseLaunchPaths(["electron", "--open"])).toThrow(
      "--open requires an absolute path",
    );
    expect(() => parseLaunchPaths(["electron", "--open", "run.csv"])).toThrow(
      "--open requires an absolute path",
    );
  });
});
