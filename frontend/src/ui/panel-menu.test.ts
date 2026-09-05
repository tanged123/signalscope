// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { showPanelMenu } from "./panel-menu";

afterEach(() => document.body.replaceChildren());

function fixture(): { container: HTMLElement; anchor: HTMLButtonElement } {
  const container = document.createElement("div");
  const anchor = document.createElement("button");
  container.append(anchor);
  document.body.append(container);
  return { container, anchor };
}

it("owns keyboard navigation, selection, and trigger focus", () => {
  const { container, anchor } = fixture();
  const run = vi.fn();
  const close = showPanelMenu(container, anchor, "X axis", [
    { label: "time", active: true, run: vi.fn() },
    { label: "<img src=x onerror=alert(1)>", active: false, run },
  ]);
  const items = container.querySelectorAll<HTMLButtonElement>(
    '[role="menuitemradio"]',
  );
  expect(document.activeElement).toBe(items[0]);
  expect(items[0]?.getAttribute("aria-checked")).toBe("true");
  expect(container.querySelector("img")).toBeNull();
  items[0]?.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
  );
  expect(document.activeElement).toBe(items[1]);
  items[1]?.click();
  expect(run).toHaveBeenCalledOnce();
  expect(container.querySelector('[role="menu"]')).toBeNull();
  expect(anchor.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(anchor);
  close();
});

it("closes on Escape and unregisters document listeners on teardown", () => {
  const { container, anchor } = fixture();
  const remove = vi.spyOn(document, "removeEventListener");
  const close = showPanelMenu(container, anchor, "Options", [
    { label: "one", active: false, run: vi.fn() },
  ]);
  document.activeElement?.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  expect(document.activeElement).toBe(anchor);
  expect(remove).toHaveBeenCalledWith(
    "pointerdown",
    expect.any(Function),
    true,
  );
  const calls = remove.mock.calls.length;
  close();
  expect(remove.mock.calls).toHaveLength(calls);
  remove.mockRestore();
});

it("closes on an outside pointer without taking focus", () => {
  const { container, anchor } = fixture();
  const outside = document.createElement("button");
  document.body.append(outside);
  const close = showPanelMenu(container, anchor, "Options", [
    { label: "one", active: false, run: vi.fn() },
  ]);
  outside.focus();
  outside.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  expect(container.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(outside);
  close();
});
