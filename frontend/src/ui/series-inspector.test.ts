// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { seriesInspector } from "./series-inspector";

it("dispatches field patches without owning panel state and treats names as text", () => {
  const actions = { close: vi.fn(), mute: vi.fn(), patch: vi.fn() };
  const inspector = seriesInspector(
    { color_by: "source", dash_by: null, width_by: null },
    {
      path: "<img src=x>",
      hue: 0,
      width: 1.5,
      dash: "solid",
      visible: true,
      overrideFields: { color: true, dash: true, width: false },
    },
    "var(--series-1)",
    actions,
  );
  expect(inspector.querySelector("img")).toBeNull();
  inspector
    .querySelector<HTMLButtonElement>('[aria-label="Color slot 3"]')
    ?.click();
  expect(actions.patch).toHaveBeenLastCalledWith({ color_slot: 3 });
  inspector.querySelector<HTMLButtonElement>(".plot-row-provenance")?.click();
  expect(actions.patch).toHaveBeenLastCalledWith({ color_slot: null });
  const width = inspector.querySelector<HTMLInputElement>(
    'input[type="range"]',
  );
  if (width === null) throw new Error("missing width control");
  width.value = "2.5";
  width.dispatchEvent(new Event("input"));
  expect(actions.patch).toHaveBeenCalledTimes(2);
  width.dispatchEvent(new Event("change"));
  expect(actions.patch).toHaveBeenLastCalledWith({ width: 2.5 });
  inspector
    .querySelector<HTMLButtonElement>(".plot-row-inspector-footer button")
    ?.click();
  expect(actions.mute).toHaveBeenCalledOnce();
  inspector
    .querySelector<HTMLButtonElement>('[title="Close line inspector"]')
    ?.click();
  expect(actions.close).toHaveBeenCalledOnce();
});
