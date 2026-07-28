/** Tooltip every surface reuses for roadmap entries that cannot run yet. */
export const PLANNED_TITLE = "planned — not yet implemented";

export interface Command {
  id: string;
  title: string;
  keys?: string;
  /** Secondary key bindings; hints keep displaying `keys`. */
  altKeys?: string[];
  section?: "file" | "view" | "workspace" | "help";
  group?: string;
  status?: "available" | "planned";
  checked?: () => boolean;
  enabled?: () => boolean;
  run: () => void;
}

export class CommandRegistry {
  /** Called with the command id after every successful execution. */
  onRun: ((id: string) => void) | null = null;

  private readonly commands = new Map<string, Command>();

  register(command: Command): void {
    this.commands.set(command.id, command);
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
    this.onRun?.(id);
    return true;
  }

  handleKey(event: KeyboardEvent): boolean {
    const combo = comboFor(event);
    if (combo === null) return false;
    for (const command of this.commands.values()) {
      if (
        (command.keys === combo ||
          (command.altKeys?.includes(combo) ?? false)) &&
        command.status !== "planned" &&
        (command.enabled?.() ?? true)
      ) {
        command.run();
        this.onRun?.(command.id);
        return true;
      }
    }
    return false;
  }
}

function comboFor(event: KeyboardEvent): string | null {
  if (event.altKey) return null;
  // Shifted ctrl+= arrives as "+" on row-number layouts; both spellings mean
  // the same zoom-in binding, so "+" folds into "=" and drops its shift.
  const key = event.key === "+" ? "=" : event.key.toLowerCase();
  if (event.metaKey || event.ctrlKey) {
    const shift = event.shiftKey && key !== "=" ? "shift+" : "";
    return `mod+${shift}${key}`;
  }
  if (event.shiftKey && key.length > 1) return `shift+${key}`;
  return key;
}

const EDITING_RESERVED = new Set(["mod+z", "mod+shift+z", "mod+y"]);

/**
 * True when the combo belongs to native text editing (undo/redo) and must
 * not be captured while an input, textarea, or contenteditable has focus.
 */
export function reservedWhileEditing(event: KeyboardEvent): boolean {
  const combo = comboFor(event);
  return combo !== null && EDITING_RESERVED.has(combo);
}

/**
 * `comboFor` accepts either metaKey or ctrlKey for `mod`, so the label has to
 * follow the platform the user is actually on: ⌘ on Apple hardware, Ctrl
 * everywhere else. The trailing "+" keeps "Ctrl+⇧P" legible next to "⌘⇧P".
 */
function modLabel(): string {
  const nav = globalThis.navigator as
    | (Navigator & { userAgentData?: { platform?: string } })
    | undefined;
  // `userAgentData` is Chromium-only; the Tauri shell runs WebKit on macOS, so
  // the user-agent string is the portable signal. `navigator.platform` is
  // deprecated and unavailable here.
  const platform = nav?.userAgentData?.platform ?? nav?.userAgent ?? "";
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘" : "Ctrl+";
}

/** Display form of a `comboFor` combo, e.g. "mod+p" → "⌘P" or "Ctrl+P". */
export function formatCombo(keys: string): string {
  const mod = modLabel();
  return keys
    .split("+")
    .map((part) =>
      part === "mod" ? mod : part === "shift" ? "⇧" : part.toUpperCase(),
    )
    .join("");
}
