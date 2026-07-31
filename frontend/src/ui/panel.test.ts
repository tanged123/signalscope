import { describe, expect, it } from "vitest";

import {
  BUNDLE_DRAG_TYPE,
  MAX_SERIES_PER_PANEL,
  SIGNAL_DRAG_TYPE,
} from "./panel";

describe("panel series", () => {
  it("keeps the panel member cap available for ordinary series", () => {
    expect(MAX_SERIES_PER_PANEL).toBe(64);
  });

  it("bundle drag type is distinct from the signal drag type", () => {
    expect(BUNDLE_DRAG_TYPE).not.toBe(SIGNAL_DRAG_TYPE);
    expect(BUNDLE_DRAG_TYPE.startsWith("application/x-signalscope")).toBe(true);
  });
});
