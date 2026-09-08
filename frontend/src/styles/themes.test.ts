// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import { THEME_ORDER, THEMES } from "../app/themes";
import { applyPreferences, defaultPreferences } from "../app/preferences";

const css = ["tokens.css", "themes.css"]
  .map((file) =>
    readFileSync(pathToFileURL(resolve(import.meta.dirname, file)), "utf8"),
  )
  .join("\n");
let sheet: HTMLStyleElement;
beforeEach(() => {
  sheet = document.createElement("style");
  sheet.textContent = css;
  document.head.append(sheet);
});
afterEach(() => {
  sheet.remove();
  document.documentElement.removeAttribute("style");
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.colorScheme;
  document.body.replaceChildren();
});

function contrast(a: string, b: string): number {
  const luminance = (hex: string): number => {
    const channels = [1, 3, 5].map((offset) => {
      const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    });
    return (
      (channels[0] ?? 0) * 0.2126 +
      (channels[1] ?? 0) * 0.7152 +
      (channels[2] ?? 0) * 0.0722
    );
  };
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

test.each(THEME_ORDER)(
  "%s supplies readable chrome and the same tokens in its preview",
  (theme) => {
    applyPreferences(
      { ...defaultPreferences(), theme },
      document.documentElement,
    );
    const root = getComputedStyle(document.documentElement);
    const preview = document.createElement("span");
    preview.className = "theme-preview";
    preview.dataset.theme = theme;
    preview.dataset.colorScheme = THEMES[theme].scheme;
    document.body.append(preview);
    const tokens = [
      "--surface-0",
      "--surface-1",
      "--fg-1",
      "--fg-2",
      "--border",
      "--grid",
      "--amber-9",
    ];
    for (const token of tokens) {
      const value = root.getPropertyValue(token).trim();
      expect(value).toMatch(/^#[0-9a-f]{6}$/i);
      expect(getComputedStyle(preview).getPropertyValue(token).trim()).toBe(
        value,
      );
    }
    expect(root.getPropertyValue("color-scheme")).toBe(THEMES[theme].scheme);
    expect(
      contrast(
        root.getPropertyValue("--fg-1").trim(),
        root.getPropertyValue("--surface-1").trim(),
      ),
    ).toBeGreaterThanOrEqual(7);
    expect(
      contrast(
        root.getPropertyValue("--fg-2").trim(),
        root.getPropertyValue("--surface-1").trim(),
      ),
    ).toBeGreaterThanOrEqual(4.5);
    if (theme.startsWith("contrast_"))
      expect(
        contrast(
          root.getPropertyValue("--fg-4").trim(),
          root.getPropertyValue("--surface-1").trim(),
        ),
      ).toBeGreaterThanOrEqual(7);
  },
);
