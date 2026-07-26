/** Tooltip every surface reuses for roadmap entries that cannot run yet. */
export const PLANNED_TITLE = "planned — not yet implemented";

export interface Command {
  id: string;
  title: string;
  keys?: string;
  section?: "file" | "view" | "workspace" | "help";
  group?: string;
  status?: "available" | "planned";
  checked?: () => boolean;
  enabled?: () => boolean;
  run: () => void;
}

export class CommandRegistry {
  private readonly commands = new Map<string, Command>();

  register(command: Command): void {
    this.commands.set(command.id, command);
  }

  list(): Command[] {
    return [...this.commands.values()].filter(
      (command) =>
        command.status !== "planned" && (command.enabled?.() ?? true),
    );
  }

  listAll(): Command[] {
    return [...this.commands.values()];
  }

  run(id: string): boolean {
    const command = this.commands.get(id);
    if (
      command === undefined ||
      command.status === "planned" ||
      !(command.enabled?.() ?? true)
    ) {
      return false;
    }
    command.run();
    return true;
  }

  handleKey(event: KeyboardEvent): boolean {
    const combo = comboFor(event);
    if (combo === null) return false;
    for (const command of this.commands.values()) {
      if (
        command.keys === combo &&
        command.status !== "planned" &&
        (command.enabled?.() ?? true)
      ) {
        command.run();
        return true;
      }
    }
    return false;
  }
}

function comboFor(event: KeyboardEvent): string | null {
  if (event.altKey) return null;
  const key = event.key.toLowerCase();
  if (event.metaKey || event.ctrlKey) {
    return `mod+${event.shiftKey ? "shift+" : ""}${key}`;
  }
  if (event.shiftKey && key.length > 1) return `shift+${key}`;
  return key;
}

/** Display form of a `comboFor` combo, e.g. "mod+p" → "⌘P". */
export function formatCombo(keys: string): string {
  return keys
    .split("+")
    .map((part) =>
      part === "mod" ? "⌘" : part === "shift" ? "⇧" : part.toUpperCase(),
    )
    .join("");
}
