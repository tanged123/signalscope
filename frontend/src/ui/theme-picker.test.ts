// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { defaultPreferences } from "../app/preferences";
import { THEME_ORDER } from "../app/themes";
import { showThemePicker } from "./theme-picker";
import { required } from "./dom";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };
});
afterEach(() => document.body.replaceChildren());

test("theme cards preview each choice, mark the current choice and restore focus on selection", () => {
  const origin = document.createElement("button");
  document.body.append(origin);
  origin.focus();
  const select = vi.fn();
  showThemePicker(
    document.body,
    { ...defaultPreferences(), theme: "paper" },
    select,
  );
  expect(document.querySelectorAll(".theme-choice")).toHaveLength(
    THEME_ORDER.length,
  );
  expect(
    required(document.body, '[aria-label="Paper"]').getAttribute(
      "aria-pressed",
    ),
  ).toBe("true");
  expect(
    required<HTMLElement>(document.body, '.theme-preview[data-theme="paper"]')
      .dataset.colorScheme,
  ).toBe("light");
  required<HTMLButtonElement>(document.body, '[aria-label="Graphite"]').click();
  expect(select).toHaveBeenCalledWith("graphite");
  expect(document.querySelector("dialog")).toBeNull();
  expect(document.activeElement).toBe(origin);
});

test("closing the picker leaves the selected theme unchanged", () => {
  const select = vi.fn();
  showThemePicker(document.body, defaultPreferences(), select);
  required<HTMLButtonElement>(
    document.body,
    '[aria-label="Close theme"]',
  ).click();
  expect(select).not.toHaveBeenCalled();
  expect(document.querySelector("dialog")).toBeNull();
});
