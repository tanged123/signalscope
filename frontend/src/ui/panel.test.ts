import { describe, expect, it } from "vitest";

import { MAX_SERIES_PER_PANEL } from "./panel";

describe("panel series", () => {
  it("keeps the panel member cap available for ordinary series", () => {
    expect(MAX_SERIES_PER_PANEL).toBe(64);
  });
});
