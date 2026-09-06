// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { required } from "./dom";
import {
  bindSessionTitle,
  renderSessionTitle,
  sessionDisplayTitle,
} from "./session-title";

describe("session title", () => {
  it("prefers a saved title and falls back to the file name", () => {
    expect(sessionDisplayTitle("Review", "/data/run.signalscope")).toBe(
      "Review",
    );
    expect(sessionDisplayTitle(null, "/data/run.signalscope")).toBe(
      "run.signalscope",
    );
    expect(sessionDisplayTitle(null, null)).toBe("Untitled");
  });
  it("commits Enter and blur, cancels Escape and empty names, and treats names as text", () => {
    const button = document.createElement("button");
    document.body.replaceChildren(button);
    let name = "Untitled";
    const commit = vi.fn((title: string) => {
      name = title;
      renderSessionTitle(button, name, true);
    });
    renderSessionTitle(button, name, false);
    bindSessionTitle(button, () => name, commit);
    const edit = (value: string, key?: string): void => {
      button.click();
      const input = required<HTMLInputElement>(document, "input");
      expect(document.activeElement).toBe(input);
      input.value = value;
      if (key)
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true }),
        );
      else input.blur();
    };
    edit("  <img src=x> review  ", "Enter");
    expect(name).toBe("<img src=x> review");
    expect(button.innerHTML).not.toContain("<img");
    expect(document.activeElement).toBe(button);
    edit("Cancelled", "Escape");
    edit("   ", "Enter");
    expect(commit).toHaveBeenCalledOnce();
    edit("Final");
    expect(commit).toHaveBeenCalledTimes(2);
    expect(button.textContent).toBe("Final •");
    document.body.replaceChildren();
  });
});
