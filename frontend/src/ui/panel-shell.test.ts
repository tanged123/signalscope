// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import {
  MAXIMIZE_GLYPH,
  PanelShell,
  type PanelShellCallbacks,
} from "./panel-shell";

function callbacks(): PanelShellCallbacks {
  return {
    onFocus: vi.fn(),
    onClose: vi.fn(),
    onSplitRight: vi.fn(),
    onSplitDown: vi.fn(),
    onMaximize: vi.fn(),
    onDropSignals: vi.fn(),
    onDropSet: vi.fn(),
    onRenameTitle: vi.fn(),
  };
}

describe("PanelShell", () => {
  it("provides stable shell anatomy and named content slots", () => {
    const shell = new PanelShell("panel-1", callbacks());

    expect(shell.element.matches("article.panel")).toBe(true);
    expect(shell.element.dataset.panelId).toBe("panel-1");
    expect(shell.element.querySelector(".panel-header")).not.toBeNull();
    expect(shell.slots.binding.className).toBe("panel-bindings");
    expect(shell.slots.content.className).toBe("plot-wrap");
    expect(shell.slots.legend.className).toBe("plot-series-legend");
    expect(shell.slots.status.className).toBe("panel-empty");
    expect(shell.element.querySelector(".panel-title")).not.toBeNull();
    expect(
      shell.element.querySelector<HTMLButtonElement>(".panel-maximize")
        ?.textContent,
    ).toBe(MAXIMIZE_GLYPH);
  });

  it("owns title, maximize state, status, and common action routing", () => {
    const panelCallbacks = callbacks();
    const shell = new PanelShell("panel-1", panelCallbacks);

    shell.setTitle("Signals", true);
    expect(shell.element.getAttribute("aria-label")).toBe("Signals panel");
    expect(shell.element.querySelector(".panel-title")?.textContent).toBe(
      "Signals",
    );
    expect(shell.element.classList.contains("maximized")).toBe(true);
    expect(
      shell.element.querySelector<HTMLButtonElement>(".panel-maximize")?.title,
    ).toBe("Restore panel");

    shell.setStatus({ kind: "error", message: "bad data" });
    expect(shell.slots.status.hidden).toBe(false);
    expect(shell.slots.status.dataset.state).toBe("error");
    expect(shell.slots.status.textContent).toBe("bad data");
    shell.setStatus({ kind: "loading", message: "Loading plot data…" });
    expect(shell.slots.status.dataset.state).toBe("loading");
    shell.setStatus({ kind: "ready" });
    expect(shell.slots.status.hidden).toBe(true);

    shell.element.querySelector<HTMLButtonElement>(".panel-close")?.click();
    shell.element
      .querySelector<HTMLButtonElement>(".panel-split-right")
      ?.click();
    shell.element
      .querySelector<HTMLButtonElement>(".panel-split-down")
      ?.click();
    shell.element.querySelector<HTMLButtonElement>(".panel-maximize")?.click();
    expect(panelCallbacks.onClose).toHaveBeenCalledWith("panel-1");
    expect(panelCallbacks.onSplitRight).toHaveBeenCalledWith("panel-1");
    expect(panelCallbacks.onSplitDown).toHaveBeenCalledWith("panel-1");
    expect(panelCallbacks.onMaximize).toHaveBeenCalledWith("panel-1");
  });

  it("keeps legend pointer actions from focusing the panel", () => {
    const panelCallbacks = callbacks();
    const shell = new PanelShell("panel-1", panelCallbacks);

    shell.slots.legend.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true }),
    );
    expect(panelCallbacks.onFocus).not.toHaveBeenCalled();
    shell.element.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true }),
    );
    expect(panelCallbacks.onFocus).toHaveBeenCalledOnce();
  });
});
