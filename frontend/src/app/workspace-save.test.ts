import { describe, expect, it } from "vitest";

import type { SessionPort } from "./data-plane";
import { persistWorkspace } from "./workspace-save";

function sessionPort(
  pickedPath: string | null,
  calls: { picked: number; saved: string[] },
): SessionPort {
  return {
    save: (_json, path) => {
      calls.saved.push(path ?? "autosave");
      return Promise.resolve(path ?? "autosave");
    },
    load: () => Promise.reject(new Error("unused")),
    reset: () => Promise.reject(new Error("unused")),
    pick: () => {
      calls.picked += 1;
      return Promise.resolve(pickedPath);
    },
  };
}

describe("persistWorkspace", () => {
  it("asks for a path when saving an unnamed workspace", async () => {
    const calls = { picked: 0, saved: [] as string[] };
    const saved = await persistWorkspace(
      sessionPort("/tmp/flight.signalscope.json", calls),
      "{}",
      null,
      false,
    );

    expect(saved).toBe("/tmp/flight.signalscope.json");
    expect(calls).toEqual({
      picked: 1,
      saved: ["/tmp/flight.signalscope.json"],
    });
  });

  it("reuses the current path for subsequent saves", async () => {
    const calls = { picked: 0, saved: [] as string[] };
    const saved = await persistWorkspace(
      sessionPort("/tmp/unused.signalscope.json", calls),
      "{}",
      "/tmp/flight.signalscope.json",
      false,
    );

    expect(saved).toBe("/tmp/flight.signalscope.json");
    expect(calls).toEqual({
      picked: 0,
      saved: ["/tmp/flight.signalscope.json"],
    });
  });

  it("always asks for a path when saving as", async () => {
    const calls = { picked: 0, saved: [] as string[] };
    const saved = await persistWorkspace(
      sessionPort("/tmp/copy.signalscope.json", calls),
      "{}",
      "/tmp/flight.signalscope.json",
      true,
    );

    expect(saved).toBe("/tmp/copy.signalscope.json");
    expect(calls).toEqual({
      picked: 1,
      saved: ["/tmp/copy.signalscope.json"],
    });
  });
});
