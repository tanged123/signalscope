import type { SampleResponse } from "../generated/protocol";

/**
 * One sample response per panel, keyed by everything the request depends on.
 * Sample-mode panels re-query on every `afterLayoutChange`, and a mode switch
 * is one, so tabbing xy -> fft -> histogram -> xy re-fetched the same window
 * four times. One entry per panel is enough to make the round trip free
 * without holding several copies of a full response per panel.
 */
export class SampleWindowCache {
  private readonly entries = new Map<
    string,
    { key: string; response: SampleResponse }
  >();

  static key(parts: {
    ids: readonly string[];
    mode: string;
    window: { t0: number; t1: number };
  }): string {
    return [
      [...parts.ids].sort().join(","),
      parts.mode,
      parts.window.t0,
      parts.window.t1,
    ]
      .map(String)
      .join("\u0000");
  }

  get(panelId: string, key: string): SampleResponse | null {
    const entry = this.entries.get(panelId);
    return entry !== undefined && entry.key === key ? entry.response : null;
  }

  store(panelId: string, key: string, response: SampleResponse): void {
    this.entries.set(panelId, { key, response });
  }

  invalidate(panelId?: string): void {
    if (panelId === undefined) this.entries.clear();
    else this.entries.delete(panelId);
  }
}
