import { required } from "./dom";
import { positionPanelPopover } from "./panel-menu";

export type PanelToolbarGroup = "data" | "appearance" | "analysis";
export interface PanelToolbarContent {
  controls: HTMLElement;
  summary: string;
}
export type PanelToolbarGroups = Record<PanelToolbarGroup, PanelToolbarContent>;

const GROUPS = {
  data: "Data & axes",
  appearance: "Appearance",
  analysis: "Analysis",
} as const;

/** Shared dropdown lifetime; plot families supply controls and current summaries. */
export class PanelToolbar {
  private readonly abort = new AbortController();
  private readonly observer: ResizeObserver;
  private readonly groups = new Map<
    PanelToolbarGroup,
    {
      button: HTMLButtonElement;
      summary: HTMLElement;
      popup: HTMLElement;
    }
  >();
  private active: PanelToolbarGroup | null = null;

  constructor(
    private readonly host: HTMLElement,
    slot: HTMLElement,
    content: PanelToolbarGroups,
    private readonly beforeOpen: () => void,
  ) {
    for (const id of Object.keys(GROUPS) as PanelToolbarGroup[]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "panel-toolbar-trigger";
      button.dataset.toolbarTrigger = id;
      button.setAttribute("aria-label", GROUPS[id]);
      button.setAttribute("aria-haspopup", "dialog");
      button.setAttribute("aria-expanded", "false");
      const label = document.createElement("span");
      label.textContent = GROUPS[id];
      const summary = document.createElement("span");
      summary.className = "panel-toolbar-summary";
      const caret = document.createElement("span");
      caret.className = "toolbar-caret";
      caret.textContent = "▾";
      caret.setAttribute("aria-hidden", "true");
      button.append(label, summary, caret);
      const popup = document.createElement("div");
      popup.className = "panel-toolbar-popover";
      popup.dataset.toolbarGroup = id;
      popup.setAttribute("role", "dialog");
      popup.setAttribute("aria-label", GROUPS[id]);
      popup.hidden = true;
      popup.append(content[id].controls);
      slot.append(button);
      host.append(popup);
      this.groups.set(id, { button, summary, popup });
      button.addEventListener(
        "click",
        () => {
          if (this.active === id) this.close();
          else this.open(id);
        },
        { signal: this.abort.signal },
      );
      button.addEventListener(
        "keydown",
        (event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          event.stopPropagation();
          this.open(id, event.key === "ArrowUp");
        },
        { signal: this.abort.signal },
      );
      popup.addEventListener("toolbar-drilldown", () => this.close(false), {
        signal: this.abort.signal,
      });
      popup.addEventListener(
        "keydown",
        (event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            this.close();
          } else if (event.key === "Tab") {
            const controls = this.controls(popup);
            const edge = event.shiftKey ? controls[0] : controls.at(-1);
            if (event.target === edge) {
              this.close();
              event.stopPropagation();
            }
          } else if (
            ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) &&
            event.target instanceof HTMLButtonElement
          ) {
            const controls = this.controls(popup);
            const index = controls.indexOf(event.target);
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? controls.length - 1
                  : (index +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      controls.length) %
                    controls.length;
            event.preventDefault();
            event.stopPropagation();
            controls[next]?.focus();
          }
        },
        { signal: this.abort.signal },
      );
      popup.addEventListener(
        "focusout",
        (event) => {
          if (
            this.active === id &&
            event.relatedTarget instanceof Node &&
            !popup.contains(event.relatedTarget) &&
            event.relatedTarget !== button
          )
            this.close(false);
        },
        { signal: this.abort.signal },
      );
      this.setSummary(id, content[id].summary);
    }
    document.addEventListener(
      "pointerdown",
      (event) => {
        const group =
          this.active === null ? undefined : this.groups.get(this.active);
        if (group === undefined || !(event.target instanceof Node)) return;
        if (
          !group.popup.contains(event.target) &&
          !group.button.contains(event.target)
        )
          this.close(false);
      },
      { capture: true, signal: this.abort.signal },
    );
    // Header controls must not start a panel drag.
    slot.addEventListener("dragstart", (event) => event.preventDefault(), {
      signal: this.abort.signal,
    });
    this.observer = new ResizeObserver(() => this.position());
    this.observer.observe(host);
  }

  setSummary(id: PanelToolbarGroup, text: string): void {
    const group = this.groups.get(id);
    if (group === undefined) return;
    group.summary.textContent = text;
    group.button.title = `${GROUPS[id]} · ${text}`;
    group.button.setAttribute("aria-description", text);
    this.position();
  }

  open(id: PanelToolbarGroup, last = false, focus = true): void {
    this.close(false);
    this.beforeOpen();
    const group = this.groups.get(id);
    if (group === undefined) return;
    this.active = id;
    group.popup.hidden = false;
    group.button.setAttribute("aria-expanded", "true");
    group.button.setAttribute("aria-haspopup", "dialog");
    this.position();
    if (focus) {
      const controls = this.controls(group.popup);
      (last ? controls.at(-1) : controls[0])?.focus();
    }
  }

  close(focus = true): void {
    const group =
      this.active === null ? undefined : this.groups.get(this.active);
    this.active = null;
    if (group === undefined) return;
    group.popup.hidden = true;
    group.button.setAttribute("aria-expanded", "false");
    if (focus) group.button.focus();
  }

  dispose(): void {
    this.close(false);
    this.abort.abort();
    this.observer.disconnect();
    for (const group of this.groups.values()) {
      group.button.remove();
      group.popup.remove();
    }
    this.groups.clear();
  }

  private position(): void {
    const group =
      this.active === null ? undefined : this.groups.get(this.active);
    if (group !== undefined)
      positionPanelPopover(this.host, group.button, group.popup);
  }

  private controls(popup: HTMLElement): HTMLElement[] {
    return [
      ...popup.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
      ),
    ].filter((button) => !button.hidden);
  }
}

/** A setting picker replaces its group dropdown and returns focus to its trigger. */
export function panelToolbarAnchor(control: HTMLElement): HTMLElement {
  const popup = control.closest<HTMLElement>(".panel-toolbar-popover");
  if (popup === null) return control;
  const trigger = required<HTMLElement>(
    popup.parentElement as HTMLElement,
    `[data-toolbar-trigger="${popup.dataset.toolbarGroup ?? ""}"]`,
  );
  popup.dispatchEvent(new Event("toolbar-drilldown"));
  return trigger;
}
