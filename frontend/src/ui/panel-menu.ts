import { clamp } from "../app/plot-math";

export interface MenuOption {
  label: string;
  active: boolean;
  action?: boolean;
  run(): void;
}

export function positionPanelPopover(
  container: HTMLElement,
  anchor: HTMLElement,
  popover: HTMLElement,
): void {
  const panelRect = container.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  const width = popover.getBoundingClientRect().width;
  popover.style.left = `${String(clamp(anchorRect.right - panelRect.left - container.clientLeft - width, 4, Math.max(4, container.clientWidth - width - 4)))}px`;
  popover.style.top = `${String(anchorRect.bottom - panelRect.top - container.clientTop + 4)}px`;
  popover.style.setProperty(
    "--panel-popover-space",
    `${String(Math.max(48, panelRect.bottom - anchorRect.bottom - 8))}px`,
  );
}

/** Owns one anchored menu and its document listeners; returns its teardown. */
export function showPanelMenu(
  container: HTMLElement,
  anchor: HTMLElement,
  label: string,
  options: readonly MenuOption[],
  searchable = false,
): () => void {
  const popover = document.createElement("div");
  popover.className = searchable
    ? "panel-config-popover axis-picker"
    : "panel-config-popover";
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
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Search signals and bundles";
  search.setAttribute("aria-label", `Search ${label.toLowerCase()}`);
  if (searchable) popover.append(search);
  const list = document.createElement("div");
  popover.append(list);
  let buttons: HTMLButtonElement[] = [];
  const render = (): void => {
    list.replaceChildren();
    const query = search.value.toLowerCase();
    const matches = options.filter((option) =>
      option.label.toLowerCase().includes(query),
    );
    buttons = (searchable ? matches.slice(0, 100) : matches).map((option) => {
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
      list.append(button);
      return button;
    });
    if (searchable) {
      const status = document.createElement("div");
      status.className = "panel-config-title";
      status.setAttribute("role", "status");
      status.textContent =
        matches.length > 100
          ? `${String(matches.length)} matches · refine search`
          : matches.length === 0
            ? "No matching signals"
            : "";
      list.append(status);
    }
  };
  render();
  search.addEventListener("input", render);
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
    if (
      event.target === search &&
      !["ArrowDown", "ArrowUp", "Enter"].includes(event.key)
    )
      return;
    if (event.target === search && event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      buttons[0]?.click();
      return;
    }
    let next: number;
    switch (event.key) {
      case "ArrowDown":
        next = (index + 1) % buttons.length;
        break;
      case "ArrowUp":
        next =
          index < 0
            ? buttons.length - 1
            : (index - 1 + buttons.length) % buttons.length;
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
  positionPanelPopover(container, anchor, popover);
  anchor.setAttribute("aria-haspopup", "menu");
  anchor.setAttribute("aria-expanded", "true");
  document.addEventListener("pointerdown", onPointer, true);
  if (searchable) search.focus();
  else buttons[0]?.focus();
  return close;
}
