import { required } from "./dom";
// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { PanelShell, type PanelShellCallbacks } from "./panel-shell";

function callbacks(): PanelShellCallbacks {
  return {
    onFocus: vi.fn(),
    onClose: vi.fn(),
    onSplitRight: vi.fn(),
    onMinimize: vi.fn(),
    onSplitDown: vi.fn(),
    onMaximize: vi.fn(),
    onDropSignals: vi.fn(),
    onDropSet: vi.fn(),
    onRenameTitle: vi.fn(),
  };
}

describe("PanelShell", () => {
  it("keeps choices stable during updates and returns focus to the panel when selection finishes", () => {
    const onSetEmptyPanelContent = vi.fn();
    const shell = new PanelShell("panel-1", {
      ...callbacks(),
      onSetEmptyPanelContent,
    });
    document.body.append(shell.element);
    shell.setStatus({
      kind: "empty",
      message: "Empty",
      content: { kind: "line2d" },
    });
    const scatter = required<HTMLButtonElement>(
      shell.slots.status,
      '[data-type="scatter2d"]',
    );
    scatter.focus();
    scatter.click();
    expect(onSetEmptyPanelContent).toHaveBeenCalledWith("panel-1", {
      kind: "scatter2d",
    });
    shell.setStatus({
      kind: "empty",
      message: "Empty",
      content: { kind: "scatter2d" },
    });
    expect(document.activeElement).toBe(scatter);
    expect(scatter.getAttribute("aria-pressed")).toBe("true");
    shell.setStatus({
      kind: "empty",
      message: "Empty panel — drag a signal here.",
    });
    expect(shell.slots.status.querySelector("button")).toBeNull();
    expect(document.activeElement).toBe(shell.element);
    shell.setStatus({ kind: "loading", message: "Loading" });
    expect(shell.slots.status.querySelector("button")).toBeNull();
    shell.setStatus({ kind: "empty", message: "No matching signals" });
    expect(shell.slots.status.textContent).toBe("No matching signals");
    shell.dispose();
    scatter.click();
    expect(onSetEmptyPanelContent).toHaveBeenCalledOnce();
    shell.element.remove();
  });
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
      shell.element
        .querySelector(".panel-layout")
        ?.getAttribute("aria-haspopup"),
    ).toBe("dialog");
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

    shell.setStatus({ kind: "error", message: "bad data" });
    expect(shell.slots.status.hidden).toBe(false);
    expect(shell.slots.status.dataset.state).toBe("error");
    expect(shell.slots.status.textContent).toBe("bad data");
    shell.setStatus({ kind: "loading", message: "Loading plot data…" });
    expect(shell.slots.status.dataset.state).toBe("loading");
    shell.setStatus({ kind: "ready" });
    expect(shell.slots.status.hidden).toBe(true);

    const choose = (text: string) => {
      required<HTMLButtonElement>(shell.element, ".panel-layout").click();
      const button = [
        ...shell.element.querySelectorAll<HTMLButtonElement>(
          ".panel-creation-menu button",
        ),
      ].find((button) => button.textContent === text);
      expect(button).toBeDefined();
      button?.click();
    };
    choose("Close panel");
    expect(shell.slots.actions.querySelectorAll("button")).toHaveLength(5);
    const min = required<HTMLButtonElement>(shell.element, ".panel-minimize");
    const max = required<HTMLButtonElement>(shell.element, ".panel-maximize");
    expect(min.disabled).toBe(false);
    expect(max.disabled).toBe(true);
    min.click();
    shell.setTitle("Signals", false);
    expect(min.disabled).toBe(true);
    expect(max.disabled).toBe(false);
    max.click();
    shell.element
      .querySelector<HTMLButtonElement>(".panel-split-down")
      ?.click();
    shell.element
      .querySelector<HTMLButtonElement>(".panel-split-right")
      ?.click();
    expect(panelCallbacks.onMinimize).toHaveBeenCalledWith("panel-1");
    expect(panelCallbacks.onSplitDown).toHaveBeenCalledWith("panel-1");
    expect(panelCallbacks.onSplitRight).toHaveBeenCalledWith("panel-1");
    expect(panelCallbacks.onClose).toHaveBeenCalledWith("panel-1");
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
