// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  PanelToolbar,
  panelToolbarAnchor,
  type PanelToolbarGroups,
} from "./panel-toolbar";
import { required } from "./dom";

const disconnect = vi.fn();
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect = disconnect;
    },
  );
});
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function fixture() {
  const host = document.createElement("article");
  const slot = document.createElement("div");
  host.append(slot);
  document.body.append(host);
  const content = (): HTMLElement => {
    const node = document.createElement("div");
    node.innerHTML =
      "<button>First control</button><button>Second control</button>";
    return node;
  };
  const groups: PanelToolbarGroups = {
    data: { controls: content(), summary: "time · 8 Y" },
    appearance: { controls: content(), summary: "2px" },
    analysis: { controls: content(), summary: "stats off" },
  };
  const beforeOpen = vi.fn();
  const toolbar = new PanelToolbar(host, slot, groups, beforeOpen);
  const trigger = (group: string) =>
    required<HTMLButtonElement>(host, `[data-toolbar-trigger="${group}"]`);
  const popup = (group: string) =>
    required<HTMLElement>(host, `[data-toolbar-group="${group}"]`);
  return { toolbar, host, trigger, popup, beforeOpen };
}

it("navigates family-supplied controls and returns focus without clearing panel state", () => {
  const { toolbar, host, trigger, popup } = fixture();
  const outerKey = vi.fn();
  host.addEventListener("keydown", outerKey);
  trigger("data").focus();
  trigger("data").dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
  );
  const controls = popup("data").querySelectorAll("button");
  expect(document.activeElement).toBe(controls[0]);
  controls[0]?.dispatchEvent(
    new KeyboardEvent("keydown", { key: "End", bubbles: true }),
  );
  expect(document.activeElement).toBe(controls[1]);
  controls[1]?.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  expect(document.activeElement).toBe(trigger("data"));
  expect(popup("data").hidden).toBe(true);
  expect(outerKey).not.toHaveBeenCalled();
  toolbar.dispose();
});

it("owns one open group and hands a stable anchor to setting pickers", () => {
  const { toolbar, trigger, popup, beforeOpen } = fixture();
  trigger("data").click();
  trigger("appearance").click();
  expect(popup("data").hidden).toBe(true);
  expect(popup("appearance").hidden).toBe(false);
  toolbar.setSummary("appearance", "3px · rail");
  expect(trigger("appearance").textContent).toContain("3px · rail");
  const anchor = panelToolbarAnchor(required(popup("appearance"), "button"));
  expect(anchor).toBe(trigger("appearance"));
  expect(popup("appearance").hidden).toBe(true);
  expect(beforeOpen).toHaveBeenCalledTimes(2);
  toolbar.dispose();
});

it("dismisses on outside click or focus leaving and releases listeners and observers", () => {
  const { toolbar, host, trigger, popup } = fixture();
  trigger("analysis").click();
  document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  expect(popup("analysis").hidden).toBe(true);
  trigger("data").click();
  required(popup("data"), "button").dispatchEvent(
    new FocusEvent("focusout", { relatedTarget: document.body, bubbles: true }),
  );
  expect(popup("data").hidden).toBe(true);
  const detached = trigger("data");
  toolbar.dispose();
  detached.click();
  expect(host.querySelectorAll(".panel-toolbar-popover")).toHaveLength(0);
  expect(disconnect).toHaveBeenCalledOnce();
});
