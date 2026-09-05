import type { Command } from "./commands";

type Behavior = Pick<Command, "run" | "enabled" | "checked">;

const definitions = {
  undo: {
    title: "Undo",
    keys: "mod+z",
    section: "workspace",
    group: "history",
  },
  redo: {
    title: "Redo",
    keys: "mod+shift+z",
    altKeys: ["mod+y"],
    section: "workspace",
    group: "history",
  },
  "save-selection-as-set": {
    title: "Save selected signals as set",
    keys: "f",
    section: "workspace",
    group: "sets",
  },
  "open-sources": { title: "Open…", keys: "o", section: "file", group: "open" },
  "open-folder": {
    title: "Open folder…",
    keys: "mod+alt+o",
    section: "file",
    group: "open",
  },
  "new-workspace-tab": {
    title: "New workspace tab",
    section: "workspace",
    group: "new",
  },
  "close-workspace-tab": { title: "Close active workspace tab" },
  "split-panel-down": {
    title: "New panel",
    keys: "n",
    section: "workspace",
    group: "new",
  },
  "cycle-cursor-mode": { title: "Cursor: cycle none/track/measure", keys: "c" },
  "toggle-all-stats": {
    title: "Toggle statistics on every panel",
    section: "view",
    group: "display",
  },
  "restore-panel-grid": { title: "Restore panel grid" },
  "focus-filter": { title: "Filter signals", keys: "/" },
  "toggle-signal-tree": {
    title: "Toggle signal tree",
    section: "view",
    group: "docks",
  },
  "toggle-linked": { title: "Toggle linked time", keys: "l" },
  "toggle-theme": {
    title: "Toggle theme",
    keys: "t",
    section: "view",
    group: "display",
  },
  "increase-plot-font": {
    title: "Plot font size: increase",
    keys: "mod+=",
    section: "view",
    group: "display",
  },
  "decrease-plot-font": {
    title: "Plot font size: decrease",
    keys: "mod+-",
    section: "view",
    group: "display",
  },
  "reset-plot-font": {
    title: "Plot font size: reset",
    keys: "mod+0",
    section: "view",
    group: "display",
  },
  "increase-plot-line-width": {
    title: "Plot line width: increase",
    section: "view",
    group: "display",
  },
  "decrease-plot-line-width": {
    title: "Plot line width: decrease",
    section: "view",
    group: "display",
  },
  "reset-plot-line-width": {
    title: "Plot line width: reset",
    section: "view",
    group: "display",
  },
  "toggle-formula": {
    title: "Toggle derived formula editor",
    keys: "e",
    section: "view",
    group: "docks",
  },
  "command-palette": {
    title: "Command list",
    keys: "mod+shift+p",
    section: "help",
    group: "commands",
  },
  "open-settings": {
    title: "Settings…",
    keys: "mod+,",
    section: "view",
    group: "display",
  },
  "go-to-signal": { title: "Go to signal", keys: "mod+p" },
  help: { title: "Keyboard help", keys: "?" },
  "about-signalscope": {
    title: "About SignalScope",
    section: "help",
    group: "about",
  },
  "new-workspace": {
    title: "New Workspace",
    keys: "mod+n",
    section: "file",
    group: "workspace",
  },
  "open-workspace": {
    title: "Open Workspace…",
    keys: "mod+o",
    section: "file",
    group: "workspace",
  },
  "save-workspace": {
    title: "Save Workspace",
    keys: "mod+s",
    section: "file",
    group: "workspace",
  },
  "save-workspace-as": {
    title: "Save Workspace As…",
    section: "file",
    group: "workspace",
  },
  "export-html": {
    title: "Export ▸ HTML Snapshot…",
    section: "file",
    group: "export",
  },
  "export-png": { title: "Export ▸ PNG…", section: "file", group: "export" },
  "export-csv": {
    title: "Export ▸ Visible CSV…",
    section: "file",
    group: "export",
  },
} satisfies Record<string, Omit<Command, "id" | keyof Behavior>>;

/** Static menu and keyboard vocabulary; composition supplies live actions. */
export function shellCommand(
  id: keyof typeof definitions,
  behavior: Behavior,
): Command {
  return { id, ...definitions[id], ...behavior };
}
