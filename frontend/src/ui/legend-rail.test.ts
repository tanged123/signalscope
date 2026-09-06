// @vitest-environment jsdom
import { required } from "./dom";
import { afterEach, expect, it, vi } from "vitest";
import {
  legendResizeHandle,
  positionLegend,
  refreshLegendWithControlFocus,
  type LegendRailHost,
} from "./legend-rail";

afterEach(() => document.body.replaceChildren());

it("keeps keyboard focus through rail collapse and expansion without triggering chart shortcuts", () => {
  const root = document.createElement("div");
  const wrap = document.createElement("div");
  const legend = document.createElement("div");
  legend.className = "plot-series-legend";
  legend.dataset.state = "rail";
  root.append(wrap);
  wrap.append(legend);
  document.body.append(root);
  wrap.getBoundingClientRect = () => ({ width: 800, height: 400 }) as DOMRect;
  legend.getBoundingClientRect = () =>
    ({ width: Number.parseFloat(legend.style.width), height: 400 }) as DOMRect;
  const shortcut = vi.fn();
  root.addEventListener("keydown", shortcut);
  const host: LegendRailHost = {
    id: "panel",
    root,
    position: null,
    size: { width: 140, height: 400 },
    anchor: null,
    dock: "right",
    commit: (layout) => {
      if (layout.size == null) throw new Error("missing committed size");
      host.size = { width: layout.size[0], height: layout.size[1] };
      refresh();
    },
    refresh: vi.fn(),
  };
  const refresh = () =>
    refreshLegendWithControlFocus(root, () => {
      legend.replaceChildren(legendResizeHandle(host, "left", legend));
      positionLegend(host);
    });
  legend.append(legendResizeHandle(host, "left", legend));
  positionLegend(host);
  const seam = () => required<HTMLButtonElement>(legend, "button");
  seam().focus();
  seam().dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
  );
  expect(legend.dataset.collapsed).toBe("true");
  expect(document.activeElement).toBe(seam());
  seam().dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
  );
  expect(legend.dataset.collapsed).toBe("false");
  refresh();
  expect(document.activeElement).toBe(seam());
  expect(shortcut).not.toHaveBeenCalled();
});

it("preserves color axis keyboard focus when refreshed data replaces its scale", () => {
  const root = document.createElement("div");
  document.body.append(root);
  const render = () => {
    const scale = document.createElement("button");
    scale.className = "legend-color-scale";
    root.replaceChildren(scale);
  };
  render();
  required<HTMLButtonElement>(root, "button").focus();
  refreshLegendWithControlFocus(root, render);
  expect(document.activeElement).toBe(root.firstChild);
});
