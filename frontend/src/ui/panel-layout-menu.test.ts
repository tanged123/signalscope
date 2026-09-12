// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { showPanelLayoutMenu } from "./panel-layout-menu";

afterEach(() => document.body.replaceChildren());

test("position stays open, creation uses the selected type, Escape returns focus, and disposal removes listeners", () => {
  const host = document.createElement("article");
  const anchor = document.createElement("button");
  host.append(anchor);
  document.body.append(host);
  const create = vi.fn();
  const actions = { create, close: vi.fn() };
  let cleanup = showPanelLayoutMenu(host, anchor, "<img src=x>", actions);
  expect(host.querySelector("img")).toBeNull();
  const buttons = () => [
    ...host.querySelectorAll<HTMLButtonElement>(".panel-creation-menu button"),
  ];
  buttons()
    .find((button) => button.textContent.includes("Left"))
    ?.click();
  expect(anchor.getAttribute("aria-expanded")).toBe("true");
  expect(
    host.querySelector('[data-position="left"]')?.getAttribute("aria-pressed"),
  ).toBe("true");
  buttons()
    .find((button) => button.dataset.type === "scatter2d")
    ?.click();
  expect(create).toHaveBeenCalledExactlyOnceWith("left", {
    kind: "scatter2d",
  });
  expect(document.activeElement).toBe(anchor);
  cleanup();
  cleanup = showPanelLayoutMenu(host, anchor, "Panel", actions);
  expect(host.querySelectorAll("svg")).toHaveLength(2);
  document.activeElement?.dispatchEvent(
    new KeyboardEvent("keydown", { key: "End", bubbles: true }),
  );
  expect(document.activeElement?.textContent).toBe("Close panel");
  document.activeElement?.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  expect(host.querySelector("[role=dialog]")).toBeNull();
  expect(document.activeElement).toBe(anchor);
  cleanup();
  cleanup = showPanelLayoutMenu(host, anchor, "Panel", actions);
  cleanup();
  document.dispatchEvent(new Event("pointerdown"));
  expect(anchor.getAttribute("aria-expanded")).toBe("false");
});
