import type { ColumnarTileResponse } from "./bin-columns";

export const COARSE_POINT_TARGET = 64;
export const SERIES_CHUNK_SIZE = 128;

export interface RefinementRequest {
  readonly panelId: string;
  readonly generation: number;
  readonly signalIds: readonly string[];
  readonly window: { t0: number; t1: number };
  readonly target: number;
}

export interface RefinementSink {
  acceptCoarse(generation: number, response: ColumnarTileResponse): void;
  acceptFine(generation: number, response: ColumnarTileResponse): void;
  fail(generation: number, signalIds: readonly string[], error: unknown): void;
}

export type RefinementQuery = (
  signalIds: readonly string[],
  window: { t0: number; t1: number },
  target: number,
) => Promise<ColumnarTileResponse>;

export class TileRefinementController {
  private activeToken = 0;

  constructor(private readonly query: RefinementQuery) {}

  begin(request: RefinementRequest, sink: RefinementSink): Promise<void> {
    const token = ++this.activeToken;
    return this.run(request, sink, token);
  }

  cancel(): void {
    this.activeToken += 1;
  }

  private async run(
    request: RefinementRequest,
    sink: RefinementSink,
    token: number,
  ): Promise<void> {
    const chunks = chunk(request.signalIds);
    try {
      for (const ids of chunks) {
        const response = await this.query(
          ids,
          request.window,
          COARSE_POINT_TARGET,
        );
        if (!this.isCurrent(token)) return;
        sink.acceptCoarse(request.generation, response);
      }
      if (request.target <= COARSE_POINT_TARGET) return;
      for (const ids of chunks) {
        const response = await this.query(ids, request.window, request.target);
        if (!this.isCurrent(token)) return;
        sink.acceptFine(request.generation, response);
      }
    } catch (error: unknown) {
      if (this.isCurrent(token))
        sink.fail(request.generation, request.signalIds, error);
    }
  }

  private isCurrent(token: number): boolean {
    return token === this.activeToken;
  }
}

function chunk(ids: readonly string[]): readonly string[][] {
  const chunks: string[][] = [];
  for (let start = 0; start < ids.length; start += SERIES_CHUNK_SIZE) {
    chunks.push(ids.slice(start, start + SERIES_CHUNK_SIZE));
  }
  return chunks;
}
