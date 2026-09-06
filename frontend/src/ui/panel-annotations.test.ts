import { expect, it } from "vitest";
import { PanelAnnotationState } from "./panel-annotations";

it("collapses empty tips and opens the first tip while respecting manual collapse", () => {
  const state = new PanelAnnotationState();
  state.prune(new Set());
  expect(state.expanded).toBe(false);
  state.prune(new Set(["tip-1"]));
  expect(state.expanded).toBe(true);
  state.expanded = false;
  state.prune(new Set(["tip-1", "tip-2"]));
  expect(state.expanded).toBe(false);
  state.prune(new Set());
  expect(state.expanded).toBe(false);
  state.prune(new Set(["tip-3"]));
  expect(state.expanded).toBe(true);
});
