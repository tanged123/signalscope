import type { DataPlane } from "./data-plane";
import type { Line2DResponse } from "./line-binary";

export async function queryLineGroups(
  plane: DataPlane,
  groups: readonly { xId: string; ids: string[] }[],
  window: { t0: number; t1: number },
  pixels: number,
  signal: AbortSignal,
): Promise<Line2DResponse> {
  const responses: Line2DResponse[] = [];
  for (const group of groups) {
    signal.throwIfAborted();
    responses.push(
      await plane.queryLine2D(
        {
          request_id: crypto.randomUUID(),
          x_signal_id: group.xId,
          y_signal_ids: group.ids,
          window,
          pixel_width: pixels,
        },
        signal,
      ),
    );
  }
  const first = responses[0];
  if (first === undefined)
    throw new Error("Choose an X signal and at least one Y signal.");
  if (responses.length === 1) return first;
  return {
    ...first,
    ys: responses.flatMap((response) =>
      response.ys.map((column) => ({
        ...column,
        coordinates: {
          anchor: response.anchor,
          x: response.x,
          level: response.level,
        },
      })),
    ),
  };
}
