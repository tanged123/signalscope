// @vitest-environment jsdom
import { expect, it } from "vitest";
import { performanceMarkup, renderPresentationStatus } from "./shell-status";

it("publishes existing estimates and exposes constraints without calling a profiler", () => {
  const root = document.createElement("div");
  root.innerHTML = performanceMarkup();
  const plan = {
    density: 2,
    targetDensity: 2 as const,
    limited: false,
    fits: true,
    requests: new Map<string, number>(),
    estimatedCpuBytes: 64_000_000,
    estimatedGpuBytes: 32_000_000,
  };
  renderPresentationStatus(root, plan);
  expect(root.querySelector(".performance-cpu")?.textContent).toBe("64.0 MB");
  expect(root.querySelector(".performance-gpu")?.textContent).toBe("32.0 MB");
  expect(root.querySelector<HTMLElement>(".presentation-status")?.hidden).toBe(
    true,
  );
  renderPresentationStatus(root, { ...plan, limited: true, density: 0.5 });
  expect(root.querySelector(".presentation-status")?.textContent).toBe(
    "Reduced resolution",
  );
  renderPresentationStatus(root, { ...plan, limited: true, fits: false });
  expect(root.querySelector(".presentation-status")?.textContent).toBe(
    "Memory constrained",
  );
  expect(root.querySelector(".performance-density")?.textContent).toBe(
    "2.00 / 2 bins per device pixel",
  );
});
