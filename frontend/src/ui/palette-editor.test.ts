// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { defaultPreferences } from "../app/preferences";
import { required } from "./dom";
import { showPaletteEditor } from "./palette-editor";
import { settingsEntries } from "./settings";

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

function select(id: string): void {
  const selector = required<HTMLSelectElement>(document.body, "select");
  selector.value = id;
  selector.dispatchEvent(new Event("change"));
}
function input(label: string, value: string): void {
  const element = required<HTMLInputElement>(
    document.body,
    `[aria-label="${label}"]`,
  );
  element.value = value;
  element.dispatchEvent(new Event("input"));
}
function click(label: string): void {
  required<HTMLButtonElement>(
    document.body,
    `button[aria-label="${label}"]`,
  ).click();
}
function submit(): HTMLButtonElement {
  return required(document.body, 'button[type="submit"]');
}

test("custom colors validate, reorder and publish once without mutating the input", () => {
  const prefs = defaultPreferences();
  const apply = vi.fn();
  showPaletteEditor(document.body, "color", prefs, apply);
  select("tol_contrast");
  expect(document.querySelectorAll(".palette-preview span")).toHaveLength(3);
  select("custom");
  input("Color 1 hex", "red");
  expect(submit().disabled).toBe(true);
  expect(apply).not.toHaveBeenCalled();
  input("Color 1 hex", "#ABCDEF");
  click("Color 1 later");
  submit().click();
  expect(apply).toHaveBeenCalledOnce();
  expect(apply.mock.calls[0]?.[0]).toMatchObject({
    color_palette: "custom",
    custom_color_palette: [
      "#d95319",
      "#abcdef",
      "#edb120",
      "#7e2f8e",
      "#77ac30",
      "#4dbeee",
      "#a2142f",
    ],
  });
  expect(prefs).toEqual(defaultPreferences());
  expect(document.querySelector("dialog")).toBeNull();
});

test("custom stops retain positions, reverse separately and cancel restores focus", () => {
  const previous = document.createElement("button");
  document.body.append(previous);
  previous.focus();
  const apply = vi.fn();
  showPaletteEditor(document.body, "contour", defaultPreferences(), apply);
  select("custom");
  click("Add stop");
  input("Stop 2 position (%)", "0");
  expect(submit().disabled).toBe(true);
  input("Stop 2 position (%)", "25");
  input("Stop 2 hex", "#123456");
  required<HTMLInputElement>(document.body, 'input[type="checkbox"]').click();
  expect(submit().disabled).toBe(false);
  submit().click();
  expect(apply.mock.calls[0]?.[0]).toMatchObject({
    contour_palette: "custom",
    contour_reversed: true,
    custom_contour_palette: [
      { position: 0, color: "#000000" },
      { position: 0.25, color: "#123456" },
      { position: 1, color: "#ffffff" },
    ],
  });
  expect(document.activeElement).toBe(previous);
  showPaletteEditor(document.body, "contour", defaultPreferences(), apply);
  select("vik");
  click("Cancel");
  expect(apply).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(previous);
});

test("settings opens each editor and reset restores appearance without resource preferences", () => {
  const prefs = {
    ...defaultPreferences(),
    color_palette: "tol_bright" as const,
    contour_reversed: true,
  };
  const update = vi.fn();
  const open = vi.fn();
  const entries = settingsEntries(prefs, update, vi.fn(), [], open);
  entries.find((entry) => entry.title === "Color palette")?.run();
  entries.find((entry) => entry.title === "Contour palette")?.run();
  expect(open.mock.calls).toEqual([["color"], ["contour"]]);
  entries
    .find((entry) => entry.title === "Reset appearance to defaults")
    ?.run();
  expect(update.mock.calls[0]?.[0]).toMatchObject({
    color_palette: "matlab",
    contour_palette: "viridis",
    contour_reversed: false,
  });
  expect(update.mock.calls[0]?.[0]).not.toHaveProperty("cache_root");
});

test("settings still adjusts plot line width in quarter steps", () => {
  const prefs = defaultPreferences();
  const entries = () =>
    settingsEntries(
      prefs,
      (patch) => Object.assign(prefs, patch),
      vi.fn(),
      [],
      vi.fn(),
    );
  const entry = entries().find((item) => item.title === "Plot line width");
  expect(entry?.hint).toBe("100%");
  entry?.adjust?.(1);
  expect(prefs.plot_line_width_scale).toBe(1.25);
  expect(entries().find((item) => item.title === "Plot line width")?.hint).toBe(
    "125%",
  );
  entry?.adjust?.(-1);
  expect(prefs.plot_line_width_scale).toBe(1);
});

test("the editors can grow beyond eight colors and 32 contour stops", () => {
  const prefs = defaultPreferences();
  prefs.custom_color_palette = Array<string>(8).fill("#123456");
  const apply = vi.fn();
  showPaletteEditor(document.body, "color", prefs, apply);
  select("custom");
  click("Add color");
  expect(document.querySelectorAll(".palette-color-row")).toHaveLength(9);
  submit().click();
  expect(apply.mock.calls[0]?.[0]).toHaveProperty("custom_color_palette", [
    ...prefs.custom_color_palette,
    "#808080",
  ]);
  prefs.custom_contour_palette = Array.from({ length: 32 }, (_, index) => ({
    position: index / 31,
    color: "#123456",
  }));
  showPaletteEditor(document.body, "contour", prefs, apply);
  select("custom");
  click("Add stop");
  expect(document.querySelectorAll(".palette-color-row")).toHaveLength(33);
  submit().click();
  expect(apply.mock.calls[1]?.[0]).toHaveProperty(
    "custom_contour_palette.length",
    33,
  );
});

test("applying a preset retains saved custom colors when the abandoned draft is invalid", () => {
  const prefs = defaultPreferences();
  prefs.custom_color_palette = ["#123456", "#abcdef"];
  prefs.custom_contour_palette = [
    { position: 0, color: "#123456" },
    { position: 1, color: "#abcdef" },
  ];
  const apply = vi.fn();
  showPaletteEditor(document.body, "color", prefs, apply);
  select("custom");
  input("Color 1 hex", "invalid");
  select("tableau10");
  submit().click();
  expect(apply.mock.calls[0]?.[0]).toMatchObject({
    color_palette: "tableau10",
    custom_color_palette: prefs.custom_color_palette,
  });
  showPaletteEditor(document.body, "contour", prefs, apply);
  select("custom");
  input("Stop 1 hex", "invalid");
  select("viridis");
  submit().click();
  expect(apply.mock.calls[1]?.[0]).toMatchObject({
    contour_palette: "viridis",
    custom_contour_palette: prefs.custom_contour_palette,
  });
});
