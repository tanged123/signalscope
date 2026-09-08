import type { Theme } from "../generated/preferences";

export const THEMES: Record<
  Theme,
  { label: string; scheme: "dark" | "light" }
> = {
  dark: { label: "Dark", scheme: "dark" },
  light: { label: "Light", scheme: "light" },
  graphite: { label: "Graphite", scheme: "dark" },
  paper: { label: "Paper", scheme: "light" },
  contrast_dark: { label: "High Contrast Dark", scheme: "dark" },
  contrast_light: { label: "High Contrast Light", scheme: "light" },
};

export const THEME_ORDER = Object.keys(THEMES) as Theme[];

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && Object.hasOwn(THEMES, value);
}

export function nextTheme(theme: Theme): Theme {
  return (
    THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length] ?? "dark"
  );
}
