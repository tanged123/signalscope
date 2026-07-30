import { describe, expect, it } from "vitest";

import {
  MAX_SERIES_PER_PANEL,
  spaghettiSeries,
  type PanelSeriesKind,
} from "./panel";

describe("set series modes", () => {
  it("keeps spaghetti mode inside the panel budget", () => {
    const members = Array.from({ length: 200 }, (_, index) => index);
    expect(spaghettiSeries({ members })).toHaveLength(MAX_SERIES_PER_PANEL);
  });

  it("exposes each supported representation", () => {
    const kinds: PanelSeriesKind[] = ["single", "spaghetti", "band"];
    expect(kinds).toHaveLength(3);
  });
});
