import { describe, expect, it } from "vitest";

import { labelFont, tickFont } from "./plot-theme";

const palette = { fontPlot: '"DejaVu Sans", sans-serif', fontSize: 11 };

describe("plot fonts", () => {
  it("derives tick and label fonts from the palette size", () => {
    expect(tickFont(palette)).toBe('11px "DejaVu Sans", sans-serif');
    expect(labelFont(palette)).toBe('11.5px "DejaVu Sans", sans-serif');
  });
});
