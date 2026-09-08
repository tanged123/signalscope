// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { THEMES, THEME_ORDER, isTheme, nextTheme } from "./themes";
import {
  applyPreferences,
  defaultPreferences,
  parsePreferences,
} from "./preferences";
import { WorkspaceModel } from "./workspace";
import { parseBakedSession } from "./baked-session";

afterEach(() => {
  document.documentElement.removeAttribute("style");
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.colorScheme;
});

test("cycling visits each named theme exactly once and wraps to the default", () => {
  let current = defaultPreferences().theme;
  const visited = [];
  for (let index = 0; index < THEME_ORDER.length; index += 1) {
    visited.push(current);
    current = nextTheme(current);
  }
  expect(visited).toEqual(THEME_ORDER);
  expect(current).toBe("dark");
  expect(nextTheme("dark")).toBe("light");
  expect(isTheme("future")).toBe(false);
  expect(isTheme("toString")).toBe(false);
});

test.each(THEME_ORDER)(
  "%s persists in preferences and sessions without changing plot palettes",
  (theme) => {
    const prefs = {
      ...defaultPreferences(),
      theme,
      color_palette: "tableau10" as const,
      contour_palette: "vik" as const,
    };
    expect(parsePreferences(JSON.stringify(prefs))).toEqual(prefs);
    const workspace = new WorkspaceModel();
    workspace.setTheme(theme);
    expect(parseBakedSession(JSON.stringify(workspace.snapshot())).theme).toBe(
      theme,
    );
    applyPreferences({ ...prefs, theme: "dark" }, document.documentElement);
    const colors = document.documentElement.style.getPropertyValue(
      "--plot-color-palette",
    );
    const contour = document.documentElement.style.getPropertyValue(
      "--plot-contour-palette",
    );
    applyPreferences(prefs, document.documentElement);
    expect(document.documentElement.dataset).toMatchObject({
      theme,
      colorScheme: THEMES[theme].scheme,
    });
    expect(
      document.documentElement.style.getPropertyValue("--plot-color-palette"),
    ).toBe(colors);
    expect(
      document.documentElement.style.getPropertyValue("--plot-contour-palette"),
    ).toBe(contour);
  },
);
