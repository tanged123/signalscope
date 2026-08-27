// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { BakedPlane, HttpPlane, selectDataPlane } from "./data-plane";

describe("selectDataPlane", () => {
  it("selects the live HTTP plane when the baked slot is empty", async () => {
    document.body.innerHTML =
      '<script id="signalscope-baked-data" type="application/json">null</script>';
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: true } as Response)),
    );

    expect(await selectDataPlane()).toBeInstanceOf(HttpPlane);
  });

  it("keeps the baked demo fallback when the live host is unavailable", async () => {
    document.body.innerHTML =
      '<script id="signalscope-baked-data" type="application/json">null</script>';
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );

    expect(await selectDataPlane()).toBeInstanceOf(BakedPlane);
  });
});
