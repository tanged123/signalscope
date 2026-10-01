import { required } from "./dom";
import { panelContentForType, panelTypeOptions } from "./panel-type-options";
import type { PanelContent } from "../generated/session";
import { positionPanelPopover } from "./panel-menu";

export interface PanelLayoutActions {
  create(position: "right" | "down", content: PanelContent): void;
  close(): void;
}

export function showPanelLayoutMenu(
  container: HTMLElement,
  anchor: HTMLElement,
  title: string,
  actions: PanelLayoutActions,
): () => void {
  let position: "right" | "down" = "right";
  const abort = new AbortController();
  const menu = document.createElement("div");
  menu.className = "panel-config-popover panel-creation-menu";
  menu.setAttribute("role", "dialog");
  menu.setAttribute("aria-label", "Add panel");
  menu.innerHTML = `<div class="panel-creation-title">Add panel</div>
    <div class="panel-creation-position"><span>Position</span>
      <div role="group" aria-label="Position">
        <button type="button" data-position="right" aria-pressed="true">→ Right</button>
        <button type="button" data-position="down" aria-pressed="false">↓ Down</button>
      </div>
    </div>
    <div class="panel-creation-types" role="group" aria-label="Panel type">
      <div class="panel-config-title">PANEL TYPE</div>
    </div>
    <div class="panel-creation-destination" aria-live="polite"></div>
    <button type="button" class="panel-creation-close">Close panel</button>`;
  required(menu, ".panel-creation-types").append(panelTypeOptions());
  const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button")];
  const placements = buttons.filter(
    (button) => button.dataset.position !== undefined,
  );
  const destination = required<HTMLElement>(
    menu,
    ".panel-creation-destination",
  );
  const updatePosition = (): void => {
    for (const button of placements)
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.position === position),
      );
    destination.textContent =
      position === "right"
        ? `→ Adds to the right of ${title}`
        : `↓ Adds below ${title}`;
  };
  const close = (focus = false): void => {
    abort.abort();
    menu.remove();
    anchor.setAttribute("aria-expanded", "false");
    if (focus) anchor.focus();
  };
  for (const button of buttons) {
    button.addEventListener(
      "click",
      () => {
        if (button.dataset.position !== undefined) {
          position = button.dataset.position as "right" | "down";
          updatePosition();
        } else {
          close(true);
          const kind = button.dataset.type;
          const content = panelContentForType(kind ?? "");
          if (content !== null) actions.create(position, content);
          else actions.close();
        }
      },
      { signal: abort.signal },
    );
  }
  menu.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return;
      }
      const index = buttons.indexOf(
        document.activeElement as HTMLButtonElement,
      );
      let next: number;
      if (event.key === "ArrowDown") next = (index + 1) % buttons.length;
      else if (event.key === "ArrowUp")
        next = (index - 1 + buttons.length) % buttons.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = buttons.length - 1;
      else return;
      event.preventDefault();
      event.stopPropagation();
      buttons[next]?.focus();
    },
    { signal: abort.signal },
  );
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (
        event.target instanceof Node &&
        !menu.contains(event.target) &&
        !anchor.contains(event.target)
      )
        close();
    },
    { capture: true, signal: abort.signal },
  );
  menu.addEventListener(
    "focusout",
    (event) => {
      if (
        event.relatedTarget instanceof Node &&
        !menu.contains(event.relatedTarget) &&
        !anchor.contains(event.relatedTarget)
      )
        close();
    },
    { signal: abort.signal },
  );
  const positionMenu = (): void =>
    positionPanelPopover(container, anchor, menu);
  window.addEventListener("resize", positionMenu, { signal: abort.signal });
  updatePosition();
  container.append(menu);
  positionMenu();
  anchor.setAttribute("aria-expanded", "true");
  placements[0]?.focus();
  return () => close();
}
