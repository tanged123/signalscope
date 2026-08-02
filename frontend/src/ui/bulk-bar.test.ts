// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { SelectionModel } from "../app/selection";
import { BulkBar } from "./bulk-bar";

describe("BulkBar", () => {
  it("follows selection size, announces the count, and dispatches actions", () => {
    const host = document.createElement("div");
    const selection = new SelectionModel();
    const callbacks = {
      onAddToPanel: vi.fn(),
      onStyle: vi.fn(),
      onHide: vi.fn(),
      onSaveSet: vi.fn(),
      onDerive: vi.fn(),
      onMerge: vi.fn(),
    };
    new BulkBar(host, selection, callbacks);

    expect(host.hidden).toBe(true);
    selection.setAll(["a", "b"]);
    expect(host.hidden).toBe(false);
    expect(host.textContent).toContain("2 selected");
    expect(host.getAttribute("aria-live")).toBe("polite");

    for (const action of ["add", "style", "hide", "save", "derive"]) {
      host
        .querySelector<HTMLButtonElement>(`[data-action="${action}"]`)
        ?.click();
    }
    expect(callbacks.onAddToPanel).toHaveBeenCalledOnce();
    expect(callbacks.onStyle).toHaveBeenCalledOnce();
    expect(callbacks.onHide).toHaveBeenCalledOnce();
    expect(callbacks.onSaveSet).toHaveBeenCalledOnce();
    expect(callbacks.onDerive).toHaveBeenCalledOnce();

    selection.clear();
    expect(host.hidden).toBe(true);
  });

  it("offers merge when enabled and dispatches the shared action", () => {
    const host = document.createElement("div");
    const selection = new SelectionModel();
    const onMerge = vi.fn();
    const bar = new BulkBar(host, selection, {
      onAddToPanel: vi.fn(),
      onStyle: vi.fn(),
      onHide: vi.fn(),
      onSaveSet: vi.fn(),
      onDerive: vi.fn(),
      onMerge,
    });
    selection.setAll(["a", "b"]);

    expect(host.querySelector('[data-action="merge"]')).toBeNull();
    bar.setMergeEnabled(true, "Merge selected channels");
    host.querySelector<HTMLButtonElement>('[data-action="merge"]')?.click();

    expect(onMerge).toHaveBeenCalledOnce();
    expect(
      host.querySelector<HTMLButtonElement>('[data-action="merge"]')?.title,
    ).toBe("Merge selected channels");
  });

  it("explains why derive is disabled for multiple channels", () => {
    const host = document.createElement("div");
    const selection = new SelectionModel();
    const bar = new BulkBar(host, selection, {
      onAddToPanel: vi.fn(),
      onStyle: vi.fn(),
      onHide: vi.fn(),
      onSaveSet: vi.fn(),
      onDerive: vi.fn(),
    });
    selection.toggle("a");

    bar.setDeriveEnabled(false, "Derive requires one channel");

    const derive = host.querySelector<HTMLButtonElement>(
      '[data-action="derive"]',
    );
    expect(derive?.disabled).toBe(true);
    expect(derive?.title).toBe("Derive requires one channel");
  });
});
