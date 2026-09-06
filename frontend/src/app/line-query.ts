import type { LineGroup } from "./line-bindings";
import type { DataPlane } from "./data-plane";
import type { Line2DResponse } from "./line-binary";

export async function queryLineGroups(
  plane: DataPlane,
  groups: readonly LineGroup[],
  window: { t0: number; t1: number },
  pixels: number,
  signal: AbortSignal,
): Promise<Line2DResponse> {
  const responses: Line2DResponse[] = [];
  for (const group of groups) {
    signal.throwIfAborted();
    const response = await plane.queryLine2D(
      {
        request_id: crypto.randomUUID(),
        x_signal_id: group.xId,
        y_signal_ids: [
          ...new Set([
            ...group.ids,
            ...Object.values(group.colorIds ?? {}).filter(
              (id) => id !== group.xId,
            ),
          ]),
        ],
        window,
        pixel_width: pixels,
      },
      signal,
    );
    const columns = new Map(
      [response.x, ...response.ys].map((column) => [column.signalId, column]),
    );
    const time = {
      signalId: response.x.signalId,
      signalPath: "time",
      unit: "s",
      values: response.anchor,
    };
    responses.push({
      ...response,
      timeX: group.timeX,
      x: group.timeX ? time : response.x,
      ys: response.ys
        .filter((column) => group.ids.includes(column.signalId))
        .map((column) => ({
          ...column,
          color: group.timeColor
            ? time
            : columns.get(group.colorIds?.[column.signalId] ?? ""),
        })),
    });
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
