import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CommandRegistry,
  formatCombo,
  reservedWhileEditing,
  setEditingReservedCombos,
  type Command,
} from "./commands";

function key(
  keyValue: string,
  modifiers: Partial<
    Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey">
  > = {},
): KeyboardEvent {
  return {
    key: keyValue,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
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

  it("distinguishes mod+p from mod+shift+p and formats both", () => {
    const registry = new CommandRegistry();
    const ran: string[] = [];
    registry.register(
      command({
        id: "signals",
        keys: "mod+p",
        run: () => ran.push("signals"),
      }),
    );
    registry.register(
      command({
        id: "commands",
        keys: "mod+shift+p",
        run: () => ran.push("commands"),
      }),
    );

    expect(registry.handleKey(key("p", { metaKey: true }))).toBe(true);
    expect(
      registry.handleKey(key("P", { metaKey: true, shiftKey: true })),
    ).toBe(true);
    expect(ran).toEqual(["signals", "commands"]);
  });

  it("dispatches mod+alt shortcuts", () => {
    const registry = new CommandRegistry();
    let runs = 0;
    registry.register(
      command({
        id: "open-folder",
        keys: "mod+alt+o",
        run: () => {
          runs += 1;
        },
      }),
    );

    expect(registry.handleKey(key("o", { ctrlKey: true, altKey: true }))).toBe(
      true,
    );
    expect(runs).toBe(1);
  });

  it("matches mod+= for ctrl+= and ctrl+shift+= (plus)", () => {
    const registry = new CommandRegistry();
    let runs = 0;
    registry.register({
      id: "increase-plot-font",
      title: "Plot font size: increase",
      keys: "mod+=",
      run: () => {
        runs += 1;
      },
    });
    expect(registry.handleKey(key("=", { ctrlKey: true }))).toBe(true);
    expect(
      registry.handleKey(key("+", { ctrlKey: true, shiftKey: true })),
    ).toBe(true);
    expect(runs).toBe(2);
  });

  it("matches altKeys as secondary bindings", () => {
    const registry = new CommandRegistry();
    let runs = 0;
    registry.register({
      id: "redo",
      title: "Redo",
      keys: "mod+shift+z",
      altKeys: ["mod+y"],
      run: () => {
        runs += 1;
      },
    });
    expect(
      registry.handleKey(key("Z", { ctrlKey: true, shiftKey: true })),
    ).toBe(true);
    expect(registry.handleKey(key("y", { ctrlKey: true }))).toBe(true);
    expect(runs).toBe(2);
  });

  it("reports run ids through onRun", () => {
    const registry = new CommandRegistry();
    const seen: string[] = [];
    registry.onRun = (id) => seen.push(id);
    registry.register({
      id: "undo",
      title: "Undo",
      keys: "mod+z",
      run: () => undefined,
    });
    registry.run("undo");
    registry.handleKey(key("z", { ctrlKey: true }));
    expect(seen).toEqual(["undo", "undo"]);
  });
});

describe("reservedWhileEditing", () => {
  afterEach(() => {
    setEditingReservedCombos([]);
  });

  it("reserves the configured command bindings", () => {
    setEditingReservedCombos(["mod+u"]);
    expect(reservedWhileEditing(key("u", { ctrlKey: true }))).toBe(true);
    expect(reservedWhileEditing(key("z", { ctrlKey: true }))).toBe(false);
  });
});

describe("formatCombo", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("spells mod as ⌘ on Apple platforms", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    });
    expect(formatCombo("mod+p")).toBe("⌘P");
    expect(formatCombo("mod+shift+p")).toBe("⌘⇧P");
    expect(formatCombo("mod+alt+o")).toBe("⌘⌥O");
  });

  it("spells mod as Ctrl everywhere else", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    });
    expect(formatCombo("mod+p")).toBe("Ctrl+P");
    expect(formatCombo("mod+shift+p")).toBe("Ctrl+⇧P");
    expect(formatCombo("mod+alt+o")).toBe("Ctrl+Alt+O");
  });

  it("prefers userAgentData over the user-agent string", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      userAgentData: { platform: "macOS" },
    });
    expect(formatCombo("mod+k")).toBe("⌘K");
  });

  it("formats unmodified and shifted keys unchanged", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
    });
    expect(formatCombo("o")).toBe("O");
    expect(formatCombo("shift+enter")).toBe("⇧ENTER");
  });

  it("lists planned commands for menus but never runs them", () => {
    const registry = new CommandRegistry();
    let ran = false;
    registry.register(
      command({
        id: "planned",
        status: "planned",
        run: () => {
          ran = true;
        },
      }),
    );

    expect(registry.listAll().map((entry) => entry.id)).toEqual(["planned"]);
    expect(registry.run("planned")).toBe(false);
    expect(ran).toBe(false);
  });
});
