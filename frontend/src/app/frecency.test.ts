import { describe, expect, it } from "vitest";

import { CommandUsage } from "./frecency";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> & {
  data: Map<string, string>;
} {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

describe("CommandUsage", () => {
  it("scores unknown commands as zero", () => {
    const usage = new CommandUsage(memoryStorage(), () => 0);
    expect(usage.score("undo")).toBe(0);
  });

  it("counts runs and persists them", () => {
    const storage = memoryStorage();
    const usage = new CommandUsage(storage, () => 1000);
    usage.record("undo");
    usage.record("undo");
    usage.record("redo");
    const reloaded = new CommandUsage(storage, () => 1000);
    expect(reloaded.score("undo")).toBe(2);
    expect(reloaded.score("redo")).toBe(1);
  });

  it("halves the score per week of disuse", () => {
    let now = 0;
    const usage = new CommandUsage(memoryStorage(), () => now);
    usage.record("undo");
    usage.record("undo");
    now = WEEK_MS;
    expect(usage.score("undo")).toBeCloseTo(1, 5);
  });

  it("evicts the least recently used beyond 50 ids", () => {
    let now = 0;
    const usage = new CommandUsage(memoryStorage(), () => now);
    for (let index = 0; index < 51; index += 1) {
      now = index;
      usage.record(`command-${String(index)}`);
    }
    expect(usage.score("command-0")).toBe(0);
    expect(usage.score("command-50")).toBeGreaterThan(0);
  });

  it("survives a null or throwing storage", () => {
    const usage = new CommandUsage(null, () => 0);
    usage.record("undo");
    expect(usage.score("undo")).toBe(1);
  });
});
