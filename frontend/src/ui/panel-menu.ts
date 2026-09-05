import { clamp } from "../app/plot-math";

interface MenuOption {
  label: string;
  active: boolean;
  action?: boolean;
  run(): void;
}

/** Owns one anchored menu and its document listeners; returns its teardown. */
export function showPanelMenu(
  container: HTMLElement,
  anchor: HTMLElement,
  label: string,
  options: readonly MenuOption[],
): () => void {
  const popover = document.createElement("div");
  popover.className = "panel-config-popover";
  popover.setAttribute("role", "menu");
  popover.setAttribute("aria-label", label);
  const title = document.createElement("div");
  title.className = "panel-config-title";
  title.textContent = label;
  popover.append(title);
  let closed = false;
  const close = (returnFocus = false): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener("pointerdown", onPointer, true);
    popover.remove();
    anchor.setAttribute("aria-expanded", "false");
    if (returnFocus) anchor.focus();
  };
  const onPointer = (event: PointerEvent): void => {
    if (event.target instanceof Node && popover.contains(event.target)) return;
    close();
  };
  const buttons = options.map((option) => {
    const button = document.createElement("button");
    button.type = "button";
    button.tabIndex = -1;
    button.setAttribute(
      "role",
      option.action === true ? "menuitem" : "menuitemradio",
    );
    if (option.action !== true)
      button.setAttribute("aria-checked", String(option.active));
    button.textContent = `${option.active ? "✓ " : option.action === true ? "" : "  "}${option.label}`;
    button.addEventListener("click", () => {
      close(true);
      option.run();
    });
    popover.append(button);
    return button;
  });
  popover.addEventListener("keydown", (event) => {
    if (event.key === "Escape" || event.key === "Tab") {
      close(true);
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    const index = buttons.findIndex(
      (button) => button === document.activeElement,
    );
    let next: number;
    switch (event.key) {
      case "ArrowDown":
        next = (index + 1) % buttons.length;
        break;
      case "ArrowUp":
        next = (index - 1 + buttons.length) % buttons.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = buttons.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    buttons[next]?.focus();
  });
  container.append(popover);
  const panelRect = container.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  popover.style.left = `${String(clamp(anchorRect.right - panelRect.left - 190, 4, Math.max(4, panelRect.width - 194)))}px`;
  popover.style.top = `${String(anchorRect.bottom - panelRect.top + 4)}px`;
  anchor.setAttribute("aria-haspopup", "menu");
  anchor.setAttribute("aria-expanded", "true");
  document.addEventListener("pointerdown", onPointer, true);
  buttons[0]?.focus();
  return close;
}
