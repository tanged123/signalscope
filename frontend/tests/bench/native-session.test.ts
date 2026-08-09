import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SESSION_SCHEMA_VERSION } from "../../src/generated/session";
import { installBenchmarkSession } from "./native-session";

describe("benchmark session", () => {
  it("installs one focused full-size response panel", async () => {
    const userData = await mkdtemp(join(tmpdir(), "signalscope-bench-"));

    await installBenchmarkSession(userData);

    const session = JSON.parse(
      await readFile(join(userData, "session.autosave.json"), "utf8"),
    ) as {
      schema_version: number;
      tabs: readonly {
        focused_panel_id: string | null;
        panels: readonly {
          id: string;
          bindings: readonly unknown[];
          layout?: unknown;
        }[];
      }[];
    };
    const tab = session.tabs[0];
    const panel = tab?.panels[0];
    expect(session.schema_version).toBe(SESSION_SCHEMA_VERSION);
    expect(session.tabs).toHaveLength(1);
    expect(tab?.focused_panel_id).toBe(panel?.id);
    expect(tab?.panels).toHaveLength(1);
    expect(panel?.bindings).toEqual([
      { kind: "query", selector: "response @*", refs: [], set_id: null },
    ]);
  });
});
