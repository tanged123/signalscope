// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { CommandPalette, type PaletteEntry } from "./command-palette";

function entry(title: string): PaletteEntry {
  return { title, hint: "signal", run: vi.fn() };
}

describe("CommandPalette", () => {
  it("passes raw signal queries to a non-fuzzy provider", () => {
    const root = document.createElement("div");
    const provider = vi.fn((mode: string, query = "") => {
      if (mode !== "signals") return [];
      if (query === "temp @ run_*") {
        return [
          entry("Add 2 signals · 2 sources to focused panel"),
          entry("plot run_01/temp"),
          entry("plot run_02/temp"),
        ];
      }
      if (query === "press") return [entry("plot bench/pressure")];
      return [];
    });
    const palette = new CommandPalette(root, provider);
    palette.open("signals");
    const input = root.querySelector<HTMLInputElement>(".palette-input");
    if (input === null) throw new Error("palette input missing");
    input.value = "temp @ run_*";
    input.dispatchEvent(new Event("input"));
    expect(
      [...root.querySelectorAll(".palette-row")].map((row) => row.textContent),
    ).toEqual([
      "Add 2 signals · 2 sources to focused panelsignal",
      "plot run_01/tempsignal",
      "plot run_02/tempsignal",
    ]);
    expect(provider).toHaveBeenLastCalledWith("signals", "temp @ run_*");

    input.value = "press";
    input.dispatchEvent(new Event("input"));
    expect(root.querySelectorAll(".palette-row")).toHaveLength(1);
    expect(root.querySelector(".palette-row")?.textContent).toContain(
      "bench/pressure",
    );
  });

  it("keeps fuzzy matching for commands", () => {
    const root = document.createElement("div");
    const palette = new CommandPalette(root, () => [
      entry("toggle-formula"),
      entry("open settings"),
    ]);
    palette.open("commands");
    const input = root.querySelector<HTMLInputElement>(".palette-input");
    if (input === null) throw new Error("palette input missing");
    input.value = "tgf";
    input.dispatchEvent(new Event("input"));
    expect(root.querySelector(".palette-row")?.textContent).toContain(
      "toggle-formula",
    );
  });
});
