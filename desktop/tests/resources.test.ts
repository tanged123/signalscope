import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDesktopResources } from "../src/resources";

describe("packaged resource lookup", () => {
  it("selects the Windows executable suffix", () => {
    expect(resolveDesktopResources("C:\\app\\resources", "win32")).toEqual({
      executable: join("C:\\app\\resources", "bin", "scope-server.exe"),
      frontend: join("C:\\app\\resources", "frontend"),
    });
  });

  it("selects the Unix executable", () => {
    expect(resolveDesktopResources("/app/resources", "linux")).toEqual({
      executable: join("/app/resources", "bin", "scope-server"),
      frontend: join("/app/resources", "frontend"),
    });
  });
});
