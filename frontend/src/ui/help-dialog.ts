import { formatCombo, type CommandRegistry } from "../app/commands";
import { required } from "./dom";

export function showHelp(root: HTMLElement, registry: CommandRegistry): void {
  if (root.querySelector(".help-dialog") !== null) return;
  const previous = document.activeElement;
  const dialog = document.createElement("dialog");
  dialog.className = "help-dialog";
  dialog.setAttribute("aria-label", "SignalScope help");
  dialog.innerHTML = `<header><strong>SignalScope help</strong><button type="button" aria-label="Close help">✕</button></header>
    <div class="help-content"><h2>Plot gestures</h2><dl></dl><h2>Keyboard shortcuts</h2><div class="help-shortcuts"></div>
    <p>Click the session title to rename it. X/Y/C bindings stay in each plot header; appearance controls are in Plot settings.</p></div>`;
  const gestures = required(dialog, "dl");
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
  const shortcuts = required(dialog, ".help-shortcuts");
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
  const close = (): void => dialog.close();
  const closeButton = required<HTMLButtonElement>(dialog, "button");
  closeButton.addEventListener("click", close);
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      close();
  });
  dialog.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Tab") {
      event.preventDefault();
      closeButton.focus();
    }
  });
  dialog.addEventListener(
    "close",
    () => {
      dialog.remove();
      if (
        previous instanceof HTMLElement &&
        previous.isConnected &&
        previous.closest("[hidden]") === null
      )
        previous.focus();
      else root.querySelector<HTMLElement>(".menu-button")?.focus();
    },
    { once: true },
  );
  root.append(dialog);
  dialog.showModal();
}
