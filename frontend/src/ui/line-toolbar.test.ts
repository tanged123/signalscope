// @vitest-environment jsdom
import { expect, test, vi } from "vitest";
import { LineToolbar } from "./line-toolbar";
import { createPanelState } from "../app/panel-defaults";
import { required } from "./dom";

test("scatter exposes C and selectable diameters down to half a pixel", () => {
  const host = document.createElement("article");
  const controls = document.createElement("span");
  host.append(controls);
  document.body.append(host);
  const setWidth = vi.fn();
  const toolbar = new LineToolbar(host, controls, {
    setWidth,
    beforeOpen: vi.fn(),
  } as unknown as ConstructorParameters<typeof LineToolbar>[2]);
  const panel = createPanelState(1, { kind: "scatter2d" });
  toolbar.update(panel);
  expect(panel.line_width).toBe(2);
  expect(required<HTMLButtonElement>(host, ".panel-c-axis").hidden).toBe(false);
  const width = required<HTMLButtonElement>(host, ".panel-line-width");
  expect(width.title).toContain("Point diameter: 2.0px");
  width.click();
  const choices = [
    ...host.querySelectorAll<HTMLButtonElement>(".panel-config-popover button"),
  ];
  const smallest = choices.find((button) =>
    button.textContent.includes("0.5 px"),
  );
  expect(smallest).toBeDefined();
  smallest?.click();
  expect(setWidth).toHaveBeenCalledWith(0.5);
  toolbar.dispose();
  host.remove();
});
