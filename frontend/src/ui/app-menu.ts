import {
  formatCombo,
  PLANNED_TITLE,
  type Command,
  type CommandRegistry,
} from "../app/commands";

const SECTIONS = ["file", "view", "workspace", "help"] as const;

export class AppMenu {
  private readonly popover: HTMLElement;
  private readonly onDocumentPointerDown = (event: PointerEvent): void => {
    const target = event.target;
    if (
      target instanceof Node &&
      !this.popover.contains(target) &&
      !this.button.contains(target)
    ) {
      this.close(true);
    }
  };

  constructor(
    private readonly button: HTMLButtonElement,
    private readonly registry: CommandRegistry,
  ) {
    this.popover = document.createElement("div");
    this.popover.className = "app-menu";
    this.popover.role = "menu";
    // Every other landmark in the shell names itself; the popover is opened
    // from an icon button, so without this the menu announces unnamed.
    this.popover.ariaLabel = "Application menu";
    this.popover.hidden = true;
    button.insertAdjacentElement("afterend", this.popover);
    button.addEventListener("click", () => {
      if (this.popover.hidden) this.open();
      else this.close(true);
    });
    this.popover.addEventListener("keydown", (event) => {
      this.onKeyDown(event);
    });
  }

  open(): void {
    this.render();
    this.popover.hidden = false;
    this.button.ariaExpanded = "true";
    document.addEventListener("pointerdown", this.onDocumentPointerDown, true);
    this.items()[0]?.focus();
  }

  close(returnFocus: boolean): void {
    if (this.popover.hidden) return;
    this.popover.hidden = true;
    this.button.ariaExpanded = "false";
    document.removeEventListener(
      "pointerdown",
      this.onDocumentPointerDown,
      true,
    );
    if (returnFocus) this.button.focus();
  }

  private render(): void {
    this.popover.replaceChildren(
      ...SECTIONS.map((section) => this.section(section)),
    );
  }

  private section(section: (typeof SECTIONS)[number]): HTMLElement {
    const element = document.createElement("section");
    element.className = "app-menu-section";
    const heading = document.createElement("div");
    heading.className = "app-menu-heading";
    heading.textContent = section.toUpperCase();
    element.appendChild(heading);
    let previousGroup: string | undefined;
    for (const command of this.registry
      .listAll()
      .filter((entry) => entry.section === section)) {
      if (
        previousGroup !== undefined &&
        command.group !== undefined &&
        command.group !== previousGroup
      ) {
        const separator = document.createElement("div");
        separator.className = "app-menu-separator";
        separator.role = "separator";
        element.appendChild(separator);
      }
      element.appendChild(this.item(command));
      previousGroup = command.group;
    }
    return element;
  }

  private item(command: Command): HTMLButtonElement {
    const item = document.createElement("button");
    item.className = "app-menu-item";
    // A command with a `checked` predicate is a toggle, so it needs the
    // checkable role for assistive tech to announce the ✓ glyph as state.
    const checkable = command.checked !== undefined;
    item.role = checkable ? "menuitemcheckbox" : "menuitem";
    if (checkable) item.ariaChecked = String(command.checked?.() === true);
    const planned = command.status === "planned";
    const enabled = command.enabled?.() ?? true;
    item.ariaDisabled = String(planned || !enabled);
    item.tabIndex = -1;
    if (planned) {
      item.classList.add("planned");
      item.title = PLANNED_TITLE;
    }
    const check = document.createElement("span");
    check.className = "app-menu-check";
    check.textContent = command.checked?.() === true ? "✓" : "";
    const title = document.createElement("span");
    title.textContent = command.title;
    const keys = document.createElement("span");
    keys.className = "app-menu-keys";
    keys.textContent =
      command.keys === undefined ? "" : formatCombo(command.keys);
    item.append(check, title, keys);
    item.addEventListener("click", () => {
      if (planned || !enabled) return;
      this.registry.run(command.id);
      this.close(true);
    });
    return item;
  }

  private items(): HTMLButtonElement[] {
    return [
      ...this.popover.querySelectorAll<HTMLButtonElement>(
        "[role=menuitem],[role=menuitemcheckbox]",
      ),
    ];
  }

  private onKeyDown(event: KeyboardEvent): void {
    // The shell binds single-key commands on `window`. While the menu owns
    // focus a stray `t`/`n`/`o` must not run behind the open popover, so no
    // key typed inside it reaches the global handler.
    event.stopPropagation();
    const items = this.items();
    const current = Math.max(
      0,
      items.indexOf(document.activeElement as HTMLButtonElement),
    );
    let next: number | null = null;
    if (event.key === "ArrowDown") next = (current + 1) % items.length;
    else if (event.key === "ArrowUp") {
      next = (current - 1 + items.length) % items.length;
    } else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else if (event.key === "Escape") {
      event.preventDefault();
      this.close(true);
      return;
    } else if (event.key === "Tab") {
      // Tab leaves the menu, so the popover must not linger over whatever the
      // focus moved to. Focus returns to the trigger first so the browser
      // resumes sequential navigation from the menu button rather than from a
      // hidden item, which would drop focus to the document.
      this.close(true);
      return;
    }
    if (next !== null) {
      event.preventDefault();
      items[next]?.focus();
    }
  }
}
