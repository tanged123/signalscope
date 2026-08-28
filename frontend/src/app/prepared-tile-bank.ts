import type { ColumnarTileResponse } from "./bin-columns";
import { prepareResponseFeeds, type SeriesFeed } from "../render/m4-feed";

export type TileBankRole = "overview" | "detail";

export interface PreparedTileBank {
  id: string;
  role: TileBankRole;
  response: ColumnarTileResponse;
  window: { t0: number; t1: number };
  visibleWindow: { t0: number; t1: number };
  idsKey: string;
  density: number;
  requestedPixelWidth: number;
  feeds: readonly Float32Array[];
  cpuBytes: number;
}

export function prepareTileBank(
  input: Omit<PreparedTileBank, "feeds" | "cpuBytes">,
): PreparedTileBank {
  const feeds = prepareResponseFeeds(input.response);
  const bank = {
    ...input,
    window: Object.freeze({ ...input.window }),
    visibleWindow: Object.freeze({ ...input.visibleWindow }),
    feeds: Object.freeze([...feeds]),
    cpuBytes: responseBytes(input.response) + feedBytes(feeds),
  };
  return Object.freeze(bank);
}

function responseBytes(response: ColumnarTileResponse): number {
  const buffers = new Set<ArrayBufferLike>();
  for (const series of response.series) {
    const columns = series.bins;
    buffers.add(columns.t0.buffer);
    buffers.add(columns.t1.buffer);
    buffers.add(columns.first.buffer);
    buffers.add(columns.last.buffer);
    buffers.add(columns.min.buffer);
    buffers.add(columns.max.buffer);
    buffers.add(columns.sum.buffer);
    buffers.add(columns.sumSq.buffer);
    buffers.add(columns.sampleCount.buffer);
    buffers.add(columns.finiteCount.buffer);
    buffers.add(columns.flags.buffer);
  }
  let bytes = 0;
  for (const buffer of buffers) bytes += buffer.byteLength;
  return bytes;
}

function feedBytes(feeds: readonly SeriesFeed[]): number {
  return feeds.reduce((bytes, feed) => bytes + feed.byteLength, 0);
}
