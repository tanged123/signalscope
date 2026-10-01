// @vitest-environment jsdom

import { expect, it, vi } from "vitest";
import { legendBulkActions } from "./legend-bulk-actions";

it("defaults to all signals when nothing is selected", () => {
  const run = vi.fn();
  const bar = legendBulkActions(
    [
      { focused: false, visible: true, opacity: 1 },
      { focused: false, visible: false, opacity: 0.5 },
    ],
    run,
  );
  const buttons = Array.from(bar.querySelectorAll("button"));
  expect(buttons.map((button) => button.textContent)).toEqual([
    "Select all",
    "Dim all",
    "Hide all",
  ]);
  buttons.forEach((button) => button.click());
  expect(run.mock.calls).toEqual([
    ["select", "all"],
    ["dim", "all"],
    ["hide", "all"],
  ]);
});

it("uses only selected signals to choose visibility and dimming actions", () => {
  const run = vi.fn();
  const bar = legendBulkActions(
    [
      { focused: true, visible: false, opacity: 0.5 },
      { focused: false, visible: true, opacity: 1 },
    ],
    run,
  );
  const buttons = Array.from(bar.querySelectorAll("button"));
  expect(buttons.map((button) => button.textContent)).toEqual([
    "Clear selection",
    "Undim selected",
    "Show selected",
  ]);
  buttons.forEach((button) => button.click());
  expect(run.mock.calls).toEqual([
    ["clear", "all"],
    ["undim", "selected"],
    ["show", "selected"],
  ]);
});
