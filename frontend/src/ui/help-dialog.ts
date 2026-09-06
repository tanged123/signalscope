import { formatCombo, type CommandRegistry } from "../app/commands";
import { required } from "./dom";
import { showInfoDialog } from "./info-dialog";

export function showHelp(root: HTMLElement, registry: CommandRegistry): void {
  const content = document.createElement("div");
  content.innerHTML = `<h2>Plot gestures</h2><dl></dl><h2>Keyboard shortcuts</h2><div class="help-shortcuts"></div>
    <p>Click the session title to rename it. Each plot header contains its X/Y/C bindings, appearance controls, and readouts.</p>`;
  const gestures = required(content, "dl");
  for (const [key, description] of [
    ["Drag", "Box zoom"],
    ["Wheel", "Zoom X at pointer"],
    ["Shift + wheel", "Zoom Y"],
    ["Right / middle drag", "Pan"],
    ["Double-click plot", "Fit view"],
    ["Click near a line", "Pin a data tip"],
    ["Drag signal onto plot", "Add series"],
  ] as const) {
    const term = document.createElement("dt");
    const value = document.createElement("dd");
    term.textContent = key;
    value.textContent = description;
    gestures.append(term, value);
  }
  const shortcuts = required(content, ".help-shortcuts");
  for (const command of registry.listAll()) {
    if (command.keys === undefined || command.status === "planned") continue;
    const row = document.createElement("div");
    const name = document.createElement("span");
    const keys = document.createElement("kbd");
    name.textContent = command.title;
    keys.textContent = formatCombo(command.keys);
    row.append(name, keys);
    shortcuts.append(row);
  }
  showInfoDialog(root, "help", "SignalScope help", content);
}
