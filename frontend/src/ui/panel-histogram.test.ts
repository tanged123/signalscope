import { describe, expect, it } from "vitest";
import type { PanelLineResponse } from "../app/line-presentation-controller";
import type { RenderSeries } from "./panel-contracts";
import { histogramQualityText } from "./panel-histogram";
import { histogramFamily } from "../app/histogram-family";
import { resolvePanelRanges } from "./panel-ranges";
import { YAxisPolicy } from "../render/y-axis";

const data: PanelLineResponse = {
  kind: "histogram",
  response: {
    request_id: "h",
    window: { t0: 1, t1: 2 },
    edges: [0, 1],
    series: [
      {
        signal_id: "1",
        signal_path: "run/value",
        unit: null,
        counts: ["0"],
        finite_count: "0",
        excluded_count: "17",
      },
    ],
  },
};

describe("histogram quality presentation", () => {
  it("does not latch count limits from an initial empty response", () => {
    const state = {
      x_range: null,
      y_range: null,
      x_scale: null,
      y_scale: null,
    };
    const axis = new YAxisPolicy();
    const context = {
      series: [{ path: "run/value", hue: 0, visible: true }],
      axisStyle: "inline" as const,
      xLabel: null,
      yLabel: null,
    };
    const empty = histogramFamily({
      ...data,
      response: { ...data.response, edges: [], series: [] },
    }).prepare(context);
    resolvePanelRanges(
      state,
      empty.plot,
      data.response.window,
      axis,
      "run/value",
    );
    const populated = histogramFamily({
      ...data,
      response: {
        ...data.response,
        series: data.response.series.map((series) => ({
          ...series,
          counts: ["4"],
          finite_count: "4",
        })),
      },
    }).prepare(context);
    const ranges = resolvePanelRanges(
      state,
      populated.plot,
      data.response.window,
      axis,
      "run/value",
    );
    expect(ranges?.y.max).toBeGreaterThanOrEqual(4);
  });

  it("preserves exact finite and excluded totals for visible series", () => {
    const series = [{ path: "run/value", visible: true }] as Pick<
      RenderSeries,
      "path" | "visible"
    >[];
    expect(
      histogramQualityText({ kind: "histogram", bin_count: 32 }, series, data),
    ).toBe("run/value: finite 0 · excluded 17");
  });

  it("omits quality for hidden series", () => {
    const series = [{ path: "run/value", visible: false }] as Pick<
      RenderSeries,
      "path" | "visible"
    >[];
    expect(
      histogramQualityText({ kind: "histogram", bin_count: 32 }, series, data),
    ).toBeNull();
  });
});
