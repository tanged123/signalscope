// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { SourceOpenDialog } from "./source-open-dialog";

afterEach(() => {
  document.body.replaceChildren();
});

describe("SourceOpenDialog", () => {
  it("routes file and folder choices through one modal", () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const selected = vi.fn();
    const dialog = new SourceOpenDialog(document.body);

    dialog.open(selected);
    expect(document.activeElement).toBe(
      document.querySelector(".source-open-files"),
    );
    document.querySelector<HTMLButtonElement>(".source-open-folder")?.click();

    expect(selected).toHaveBeenCalledWith("folder");
    expect(
      document.querySelector<HTMLElement>(".source-open-overlay")?.hidden,
    ).toBe(true);
    expect(document.activeElement).toBe(trigger);

    dialog.open(selected);
    document.querySelector<HTMLButtonElement>(".source-open-files")?.click();
    expect(selected).toHaveBeenLastCalledWith("files");
  });

  it("dismisses without selecting", () => {
    const selected = vi.fn();
    const dialog = new SourceOpenDialog(document.body);
    dialog.open(selected);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(selected).not.toHaveBeenCalled();
    expect(
      document.querySelector<HTMLElement>(".source-open-overlay")?.hidden,
    ).toBe(true);
  });
});
