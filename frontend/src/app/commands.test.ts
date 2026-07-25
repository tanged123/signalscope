import { describe, expect, it } from "vitest";

import { CommandRegistry, type Command } from "./commands";

function key(
  keyValue: string,
  modifiers: Partial<
    Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey">
  > = {},
): KeyboardEvent {
  return {
    key: keyValue,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...modifiers,
  } as KeyboardEvent;
}

function command(overrides: Partial<Command> & { id: string }): Command {
  return { title: overrides.id, run: () => undefined, ...overrides };
}

describe("CommandRegistry", () => {
  it("runs commands by id and reports unknown ids", () => {
    const registry = new CommandRegistry();
    let ran = 0;
    registry.register(command({ id: "a", run: () => (ran += 1) }));
    expect(registry.run("a")).toBe(true);
    expect(registry.run("missing")).toBe(false);
    expect(ran).toBe(1);
  });

  it("dispatches plain keys and mod combos, skipping disabled commands", () => {
    const registry = new CommandRegistry();
    const ran: string[] = [];
    registry.register(
      command({ id: "open", keys: "o", run: () => ran.push("open") }),
    );
    registry.register(
      command({
        id: "palette",
        keys: "mod+k",
        run: () => ran.push("palette"),
      }),
    );
    registry.register(
      command({
        id: "off",
        keys: "x",
        enabled: () => false,
        run: () => ran.push("off"),
      }),
    );
    expect(registry.handleKey(key("o"))).toBe(true);
    expect(registry.handleKey(key("k", { ctrlKey: true }))).toBe(true);
    expect(registry.handleKey(key("k", { metaKey: true }))).toBe(true);
    expect(registry.handleKey(key("x"))).toBe(false);
    expect(registry.handleKey(key("o", { altKey: true }))).toBe(false);
    expect(ran).toEqual(["open", "palette", "palette"]);
  });

  it("list() hides disabled commands", () => {
    const registry = new CommandRegistry();
    registry.register(command({ id: "on" }));
    registry.register(command({ id: "off", enabled: () => false }));
    expect(registry.list().map((entry) => entry.id)).toEqual(["on"]);
  });
});
