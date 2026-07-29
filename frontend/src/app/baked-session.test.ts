import { describe, expect, it } from "vitest";

import { SESSION_SCHEMA_VERSION } from "../generated/session";
import { parseBakedSession } from "./baked-session";
import { emptySession } from "./workspace";

describe("parseBakedSession", () => {
  it("accepts a current-version session", () => {
    const json = JSON.stringify(emptySession());
    expect(parseBakedSession(json).schema_version).toBe(SESSION_SCHEMA_VERSION);
  });

  it("rejects a foreign app", () => {
    const json = JSON.stringify({ ...emptySession(), app: "other" });
    expect(() => parseBakedSession(json)).toThrow(/app/);
  });

  it("rejects a schema version mismatch", () => {
    const json = JSON.stringify({
      ...emptySession(),
      schema_version: 1,
    });
    expect(() => parseBakedSession(json)).toThrow(/schema/);
  });

  it("rejects an invalid current-version session", () => {
    const incomplete: Record<string, unknown> = { ...emptySession() };
    delete incomplete.linked_time;
    expect(() => parseBakedSession(JSON.stringify(incomplete))).toThrow(
      /structure/,
    );

    const invalidPanel = emptySession();
    const tab = invalidPanel.tabs[0];
    if (tab === undefined) throw new Error("default tab is missing");
    tab.panels = [{} as never];
    expect(() => parseBakedSession(JSON.stringify(invalidPanel))).toThrow(
      /structure/,
    );
  });
});
