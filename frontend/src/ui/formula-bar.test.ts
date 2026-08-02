// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { SIGNAL_DRAG_TYPE } from "./panel";
import { FormulaBar, formulaBarMarkup } from "./formula-bar";

describe("FormulaBar signal references", () => {
  it("inserts a quoted signal path when dragged", () => {
    const form = document.createElement("form");
    form.innerHTML = formulaBarMarkup().replace(/^<form[^>]*>|<\/form>$/g, "");
    const bar = new FormulaBar(form, {
      onCreate: vi.fn(),
      onClose: vi.fn(),
    });
    const input = form.querySelector<HTMLInputElement>(".formula-input");
    if (input === null) throw new Error("formula input missing");
    input.focus();
    input.setSelectionRange(0, 0);
    const payload = JSON.stringify({
      paths: ["run_01/alt", "run_02/alt"],
    });
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: {
        types: [SIGNAL_DRAG_TYPE],
        getData: (type: string) => (type === SIGNAL_DRAG_TYPE ? payload : ""),
      },
    });
    form.dispatchEvent(drop);

    expect(input.value).toBe("'run_01/alt'");
    bar.setOpen(false);
  });
});
