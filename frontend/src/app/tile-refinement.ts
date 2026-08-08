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

export interface RefinementGeneration {
  readonly id: number;
  readonly controller: AbortController;
  readonly paddedWindow: { t0: number; t1: number };
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
  signal?: AbortSignal,
) => Promise<ColumnarTileResponse>;

export class TileRefinementController {
  private activeToken = 0;
  private active: RefinementGeneration | null = null;
  private completion = Promise.resolve();

  constructor(private readonly query: RefinementQuery) {}

  begin(request: RefinementRequest, sink: RefinementSink): Promise<void> {
    this.start(request, sink);
    return this.completion;
  }

  cancel(): void {
    this.cancelActive();
  }

  start(request: RefinementRequest, sink: RefinementSink): number {
    this.cancelActive();
    const generation: RefinementGeneration = {
      id: request.generation,
      controller: new AbortController(),
      paddedWindow: request.window,
    };
    const token = ++this.activeToken;
    this.active = generation;
    this.completion = this.run(request, sink, token, generation).finally(() => {
      if (this.active === generation) this.active = null;
    });
    return generation.id;
  }

  cancelActive(): void {
    this.activeToken += 1;
    this.active?.controller.abort();
    this.active = null;
  }

  private async run(
    request: RefinementRequest,
    sink: RefinementSink,
    token: number,
    generation: RefinementGeneration,
  ): Promise<void> {
    const chunks = chunk(request.signalIds);
    try {
      for (const ids of chunks) {
        const response = await abortable(
          this.query(
            ids,
            request.window,
            COARSE_POINT_TARGET,
            generation.controller.signal,
          ),
          generation.controller.signal,
        );
        if (!this.isCurrent(token, generation)) return;
        sink.acceptCoarse(request.generation, response);
      }
      if (request.target <= COARSE_POINT_TARGET) return;
      for (const ids of chunks) {
        const response = await abortable(
          this.query(
            ids,
            request.window,
            request.target,
            generation.controller.signal,
          ),
          generation.controller.signal,
        );
        if (!this.isCurrent(token, generation)) return;
        sink.acceptFine(request.generation, response);
      }
    } catch (error: unknown) {
      if (this.isCurrent(token, generation))
        sink.fail(request.generation, request.signalIds, error);
    }
  }

  private isCurrent(token: number, generation: RefinementGeneration): boolean {
    return (
      token === this.activeToken &&
      this.active?.id === generation.id &&
      !generation.controller.signal.aborted
    );
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function abortError(): DOMException {
  return new DOMException("tile refinement aborted", "AbortError");
}

function chunk(ids: readonly string[]): readonly string[][] {
  const chunks: string[][] = [];
  for (let start = 0; start < ids.length; start += SERIES_CHUNK_SIZE) {
    chunks.push(ids.slice(start, start + SERIES_CHUNK_SIZE));
  }
  return chunks;
}
