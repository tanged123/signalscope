// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import type { ContainerOutline } from "../generated/protocol";
import { ImportWizard } from "./import-wizard";

const outline: ContainerOutline = {
  container: "hdf5",
  datasets: [
    {
      path: "run/ax",
      kind: "numeric",
      len: "300",
      shape: [300],
      sample_preview: [1, 2, 3],
    },
    {
      path: "run/time",
      kind: "numeric",
      len: "300",
      shape: [300],
      sample_preview: [0, 0.1, 0.2],
    },
    {
      path: "run/label",
      kind: "text",
      len: "300",
      shape: [300],
      sample_preview: [],
    },
  ],
};

describe("ImportWizard", () => {
  it("proposes the largest monotonic numeric dataset as the timebase", () => {
    const wizard = ImportWizard.fromOutline(outline);
    expect(wizard.proposedTime()).toBe("run/time");
    expect(wizard.selectableSignals()).toEqual(["run/ax"]);
  });

  it("emits a recipe without executable fields", () => {
    const wizard = ImportWizard.fromOutline(outline);
    wizard.setTime("run/time");
    wizard.setNameRule({ kind: "strip", prefix: "run/" });
    const toml = wizard.toToml();
    expect(toml).toContain('kind = "dataset"');
    expect(toml).not.toMatch(/command|plugin|decoder/);
  });

  it("renders untrusted dataset names as text", () => {
    const first = outline.datasets[0];
    if (first === undefined) throw new Error("expected a dataset");
    const wizard = ImportWizard.fromOutline({
      ...outline,
      datasets: [
        {
          ...first,
          path: "<img src=x onerror=alert(1)>",
        },
      ],
    });
    const row = wizard.render().querySelector(".wizard-dataset");
    expect(row?.innerHTML).not.toContain("<img");
    expect(row?.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});
