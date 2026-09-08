import { THEMES, THEME_ORDER } from "../app/themes";
import { discreteColors } from "../app/palettes";
import type { Preferences, Theme } from "../generated/preferences";
import { showInfoDialog } from "./info-dialog";

export function showThemePicker(
  root: HTMLElement,
  preferences: Preferences,
  select: (theme: Theme) => void,
): void {
  const content = document.createElement("div");
  const description = document.createElement("p");
  description.textContent =
    "Choose the workbench and plot background. Color and contour palettes stay unchanged. Press T outside this dialog to cycle themes.";
  const choices = document.createElement("div");
  choices.className = "theme-choices";
  for (const id of THEME_ORDER) {
    const theme = THEMES[id];
    const choice = document.createElement("button");
    choice.type = "button";
    choice.className = "theme-choice";
    choice.setAttribute("aria-label", theme.label);
    choice.setAttribute("aria-pressed", String(id === preferences.theme));
    const preview = document.createElement("span");
    preview.className = "theme-preview";
    preview.dataset.theme = id;
    preview.dataset.colorScheme = theme.scheme;
    preview.setAttribute("aria-hidden", "true");
    preview.innerHTML =
      '<span class="theme-preview-toolbar">Signals</span><span class="theme-preview-value">1.23</span><span class="theme-preview-line"></span>';
    const line = preview.querySelector<HTMLElement>(".theme-preview-line");
    if (line !== null)
      line.style.borderColor = discreteColors(preferences)[0] ?? "";
    const label = document.createElement("span");
    label.className = "theme-choice-label";
    label.textContent = theme.label;
    choice.append(preview, label);
    choice.addEventListener("click", () => {
      select(id);
      content.closest("dialog")?.close();
    });
    choices.append(choice);
  }
  content.append(description, choices);
  showInfoDialog(root, "theme", "Theme", content);
}
