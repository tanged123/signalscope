import {
  COLOR_PALETTES,
  CONTOUR_PALETTES,
  HEX_COLOR,
  MAX_COLORS,
  MAX_CONTOUR_STOPS,
  discreteColors,
  contourStops,
  palettePreferences,
  validColors,
  validStops,
} from "../app/palettes";
import type {
  ColorPalette,
  ContourPalette,
  ContourStop,
  Preferences,
} from "../generated/preferences";

export function showPaletteEditor(
  root: HTMLElement,
  kind: "color" | "contour",
  preferences: Preferences,
  apply: (patch: Partial<Preferences>) => void,
): void {
  if (root.querySelector(".palette-editor") !== null) return;
  const previous = document.activeElement;
  const draft = { ...preferences, ...palettePreferences(preferences) };
  const continuous = kind === "contour";
  const title = continuous ? "Contour palette" : "Color palette";
  const dialog = document.createElement("dialog");
  dialog.className = "info-dialog palette-editor";
  dialog.setAttribute("aria-label", title);
  const form = document.createElement("form");
  const header = document.createElement("header");
  const heading = document.createElement("strong");
  heading.textContent = title;
  header.append(
    heading,
    button("Close palette editor", () => dialog.close(), "✕"),
  );
  const body = document.createElement("div");
  body.className = "info-content";
  const description = document.createElement("p");
  description.textContent = continuous
    ? "Continuous values, including the C axis. Sequential maps show magnitude; diverging maps emphasize the middle of the range."
    : "Discrete colors for series and bundles. Order determines the color cycle; line styles and labels still identify series.";
  const selector = document.createElement("select");
  selector.setAttribute("aria-label", "Preset");
  const presets: Record<string, { label: string }> = continuous
    ? CONTOUR_PALETTES
    : COLOR_PALETTES;
  for (const [id, preset] of Object.entries(presets)) {
    selector.add(new Option(preset.label, id));
  }
  selector.add(new Option("Custom", "custom"));
  selector.value = continuous ? draft.contour_palette : draft.color_palette;
  const presetLabel = document.createElement("label");
  presetLabel.textContent = "Preset";
  presetLabel.append(selector);
  const preview = document.createElement("div");
  preview.className = "palette-preview";
  preview.setAttribute("role", "img");
  preview.setAttribute("aria-label", title + " preview");
  const reverse = document.createElement("input");
  reverse.type = "checkbox";
  reverse.checked = draft.contour_reversed;
  const reverseLabel = document.createElement("label");
  reverseLabel.className = "palette-reverse";
  reverseLabel.append(reverse, "Reverse");
  reverseLabel.hidden = !continuous;
  const custom = document.createElement("fieldset");
  custom.className = "palette-custom";
  custom.setAttribute("aria-label", "Custom colors");
  const rows = document.createElement("div");
  rows.className = "palette-color-rows";
  const help = document.createElement("p");
  help.textContent = continuous
    ? "Choose 2–32 colors with increasing positions from 0% to 100%. Colors interpolate between stops."
    : "Choose 1–8 colors. Use hex values or color pickers; arrows change the order.";
  const error = document.createElement("p");
  error.className = "palette-error";
  error.setAttribute("role", "alert");
  const add = button(continuous ? "Add stop" : "Add color", () => {
    if (continuous) {
      const stops = draft.custom_contour_palette;
      let index = 0;
      for (let i = 1; i < stops.length - 1; i += 1) {
        if (
          (stops[i + 1]?.position ?? 0) - (stops[i]?.position ?? 0) >
          (stops[index + 1]?.position ?? 0) - (stops[index]?.position ?? 0)
        )
          index = i;
      }
      stops.splice(index + 1, 0, {
        position:
          ((stops[index]?.position ?? 0) + (stops[index + 1]?.position ?? 1)) /
          2,
        color: "#808080",
      });
    } else draft.custom_color_palette.push("#808080");
    renderRows();
    rows.lastElementChild
      ?.querySelector<HTMLInputElement>('input[type="color"]')
      ?.focus();
  });
  custom.append(help, rows, add);
  const footer = document.createElement("footer");
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "Apply";
  footer.append(
    button("Cancel", () => dialog.close()),
    submit,
  );
  body.append(description, presetLabel, preview, reverseLabel, custom, error);
  form.append(header, body, footer);
  dialog.append(form);

  function refresh(): void {
    const isCustom = selector.value === "custom";
    custom.hidden = !isCustom;
    custom.disabled = !isCustom;
    const valid =
      !isCustom ||
      (continuous
        ? validStops(draft.custom_contour_palette)
        : validColors(draft.custom_color_palette));
    submit.disabled = !valid;
    error.textContent = valid
      ? ""
      : continuous
        ? "Use #RRGGBB colors and strictly increasing positions between 0% and 100%."
        : "Use a six-digit hex color: #RRGGBB.";
    add.disabled =
      !valid ||
      (continuous
        ? draft.custom_contour_palette.length >= MAX_CONTOUR_STOPS
        : draft.custom_color_palette.length >= MAX_COLORS);
    if (!valid) return;
    preview.replaceChildren();
    preview.style.background = "";
    if (continuous) {
      preview.style.background =
        "linear-gradient(to right in srgb, " +
        contourStops(draft)
          .map((stop) => stop.color + " " + String(stop.position * 100) + "%")
          .join(", ") +
        ")";
    } else {
      for (const [index, color] of discreteColors(draft).entries()) {
        const swatch = document.createElement("span");
        swatch.style.background = color;
        swatch.title = String(index + 1) + ": " + color;
        preview.append(swatch);
      }
    }
  }

  function renderRows(): void {
    rows.replaceChildren();
    const colors = continuous
      ? draft.custom_contour_palette.map((stop) => stop.color)
      : draft.custom_color_palette;
    colors.forEach((color, index) => {
      const stop = continuous
        ? (draft.custom_contour_palette[index] as ContourStop)
        : null;
      const row = document.createElement("div");
      row.className = "palette-color-row";
      const name = (continuous ? "Stop " : "Color ") + String(index + 1);
      const picker = document.createElement("input");
      picker.type = "color";
      picker.value = HEX_COLOR.test(color) ? color : "#000000";
      picker.setAttribute("aria-label", name);
      const hex = document.createElement("input");
      hex.type = "text";
      hex.value = color;
      hex.spellcheck = false;
      hex.setAttribute("aria-label", name + " hex");
      hex.setAttribute("aria-invalid", String(!HEX_COLOR.test(color)));
      const setColor = (value: string): void => {
        if (stop !== null) stop.color = value;
        else draft.custom_color_palette[index] = value;
        hex.setAttribute("aria-invalid", String(!HEX_COLOR.test(value)));
        refresh();
      };
      picker.addEventListener("input", () => {
        hex.value = picker.value;
        setColor(picker.value);
      });
      hex.addEventListener("input", () => {
        const value = hex.value.trim().toLowerCase();
        if (HEX_COLOR.test(value)) picker.value = value;
        setColor(value);
      });
      row.append(picker, hex);
      if (stop !== null) {
        const position = document.createElement("input");
        position.type = "number";
        position.min = "0";
        position.max = "100";
        position.step = "any";
        position.value = String(stop.position * 100);
        position.setAttribute("aria-label", name + " position (%)");
        position.disabled = index === 0 || index === colors.length - 1;
        position.addEventListener("input", () => {
          stop.position = position.valueAsNumber / 100;
          refresh();
        });
        row.append(position);
      } else {
        for (const direction of [-1, 1]) {
          const move = button(
            name + (direction < 0 ? " earlier" : " later"),
            () => {
              const next = index + direction;
              const items = draft.custom_color_palette;
              [items[index], items[next]] = [
                items[next] as string,
                items[index] as string,
              ];
              renderRows();
              rows.children[next]
                ?.querySelector<HTMLInputElement>("input")
                ?.focus();
            },
            direction < 0 ? "↑" : "↓",
          );
          move.disabled =
            index + direction < 0 || index + direction >= colors.length;
          row.append(move);
        }
      }
      const remove = button(
        "Remove " + name.toLowerCase(),
        () => {
          if (continuous) draft.custom_contour_palette.splice(index, 1);
          else draft.custom_color_palette.splice(index, 1);
          renderRows();
          add.focus();
        },
        "×",
      );
      remove.disabled = continuous
        ? index === 0 || index === colors.length - 1
        : colors.length === 1;
      row.append(remove);
      rows.append(row);
    });
    refresh();
  }

  selector.addEventListener("change", () => {
    if (continuous) draft.contour_palette = selector.value as ContourPalette;
    else draft.color_palette = selector.value as ColorPalette;
    refresh();
  });
  reverse.addEventListener("change", () => {
    draft.contour_reversed = reverse.checked;
    refresh();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    apply(palettePreferences(draft));
    dialog.close();
  });
  dialog.addEventListener("keydown", (event) => event.stopPropagation());
  dialog.addEventListener(
    "close",
    () => {
      dialog.remove();
      if (
        previous instanceof HTMLElement &&
        previous.isConnected &&
        previous.closest("[hidden]") === null
      )
        previous.focus();
      else root.querySelector<HTMLElement>(".menu-button")?.focus();
    },
    { once: true },
  );
  renderRows();
  root.append(dialog);
  dialog.showModal();
}

function button(
  label: string,
  run: () => void,
  text = label,
): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = text;
  element.setAttribute("aria-label", label);
  element.addEventListener("click", run);
  return element;
}
