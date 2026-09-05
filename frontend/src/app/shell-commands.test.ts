import { expect, it, vi } from "vitest";
import { CommandRegistry } from "./commands";
import { shellCommand } from "./shell-commands";

it("binds stable command metadata to live capability checks", () => {
  let available = false;
  const run = vi.fn();
  const registry = new CommandRegistry();
  const command = shellCommand("open-sources", {
    enabled: () => available,
    run,
  });
  expect(command).toMatchObject({
    id: "open-sources",
    title: "Open…",
    keys: "o",
    section: "file",
    group: "open",
  });
  registry.register(command);
  expect(registry.run(command.id)).toBe(false);
  available = true;
  expect(registry.run(command.id)).toBe(true);
  expect(run).toHaveBeenCalledOnce();
});

it("keeps history shortcuts and alternate bindings in the catalog", () => {
  expect(shellCommand("undo", { run: vi.fn() }).keys).toBe("mod+z");
  expect(shellCommand("redo", { run: vi.fn() })).toMatchObject({
    keys: "mod+shift+z",
    altKeys: ["mod+y"],
  });
});
