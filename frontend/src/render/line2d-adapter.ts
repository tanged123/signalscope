import type { Range } from "../app/plot-math";
import { DEFAULT_PANEL_LINE_WIDTH } from "../app/style-defaults";
import type { Line2DRenderInput } from "./line2d";
import type { SeriesStroke } from "./plot-theme";

export interface Line2DAdapterOptions {
  xRange: Range;
  yRange: readonly [number, number];
  xLabel: string;
  yLabel: string;
  styles?: readonly SeriesStroke[];
  axisStyle: "gutter" | "inline";
}

const DEFAULT_STROKE: SeriesStroke = {
  hue: null,
  dash: "solid",
  width: DEFAULT_PANEL_LINE_WIDTH,
  alpha: 1,
};

export function strokeAt(
  options: Line2DAdapterOptions,
  index: number,
): SeriesStroke {
  return options.styles?.[index] ?? DEFAULT_STROKE;
}

export function line2DAxes(
  options: Line2DAdapterOptions,
): Line2DRenderInput["axes"] {
  return {
    x: { label: options.xLabel },
    y: { label: options.yLabel },
    style: options.axisStyle,
  };
}

export function createFeedCache<Key extends object, Descriptor, Feed>(
  sameDescriptor: (left: Descriptor, right: Descriptor) => boolean,
): (key: Key, descriptor: Descriptor, build: () => Feed) => Feed {
  const entries = new WeakMap<Key, { descriptor: Descriptor; feed: Feed }>();
  return (key, descriptor, build) => {
    const cached = entries.get(key);
    if (cached !== undefined && sameDescriptor(cached.descriptor, descriptor)) {
      return cached.feed;
    }
    const result = build();
    entries.set(key, { descriptor, feed: result });
    return result;
  };
}
