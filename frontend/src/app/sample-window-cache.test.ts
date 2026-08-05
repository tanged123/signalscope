import { describe, expect, it } from "vitest";
import { SampleWindowCache } from "./sample-window-cache";
import type { SampleResponse } from "../generated/protocol";

const response = (id: string): SampleResponse => ({
  request_id: id,
  series: [],
});

const key = (over: Partial<Parameters<typeof SampleWindowCache.key>[0]> = {}) =>
  SampleWindowCache.key({
    ids: ["1", "2"],
    mode: "xy",
    window: { t0: 0, t1: 10 },
    cap: 8192,
    ...over,
  });

describe("SampleWindowCache", () => {
  it("returns a stored response for an identical key", () => {
    const cache = new SampleWindowCache();
    cache.store("panel", key(), response("a"));
    expect(cache.get("panel", key())?.request_id).toBe("a");
  });

  it("is insensitive to signal id order", () => {
    const cache = new SampleWindowCache();
    cache.store("panel", key({ ids: ["1", "2"] }), response("a"));
    expect(cache.get("panel", key({ ids: ["2", "1"] }))?.request_id).toBe("a");
  });

  it("misses on a different mode, window, or cap", () => {
    const cache = new SampleWindowCache();
    cache.store("panel", key(), response("a"));
    expect(cache.get("panel", key({ mode: "fft" }))).toBeNull();
    expect(cache.get("panel", key({ window: { t0: 0, t1: 11 } }))).toBeNull();
    expect(cache.get("panel", key({ cap: 32768 }))).toBeNull();
  });

  it("retains entries for other panels when one is invalidated", () => {
    const cache = new SampleWindowCache();
    cache.store("a", key(), response("a"));
    cache.store("b", key(), response("b"));
    cache.invalidate("a");
    expect(cache.get("a", key())).toBeNull();
    expect(cache.get("b", key())?.request_id).toBe("b");
  });

  it("clears everything when invalidated without a panel", () => {
    const cache = new SampleWindowCache();
    cache.store("a", key(), response("a"));
    cache.invalidate();
    expect(cache.get("a", key())).toBeNull();
  });

  it("keeps at most one entry per panel", () => {
    const cache = new SampleWindowCache();
    cache.store("panel", key({ mode: "xy" }), response("a"));
    cache.store("panel", key({ mode: "fft" }), response("b"));
    expect(cache.get("panel", key({ mode: "xy" }))).toBeNull();
    expect(cache.get("panel", key({ mode: "fft" }))?.request_id).toBe("b");
  });
});
