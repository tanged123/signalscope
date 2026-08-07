import { describe, expect, it } from "vitest";
import {
  MAXIMIZE_GLYPH,
  dragData,
  parseSetPayload,
  parseSignalPayload,
  parseSignalRefsPayload,
  sameRenderInputs,
} from "./panel";

describe("time panel inputs", () => {
  const tiles = { requestId: "r", series: [] };
  const base = {
    revision: 3,
    tiles,
    window: { t0: 0, t1: 1 },
    missingEmpty: true,
  };

  it("skips only when the tile identity, revision, and window match", () => {
    expect(sameRenderInputs(base, { ...base })).toBe(true);
    expect(sameRenderInputs(base, { ...base, revision: 4 })).toBe(false);
    expect(
      sameRenderInputs(base, {
        ...base,
        tiles: { requestId: "s", series: [] },
      }),
    ).toBe(false);
    expect(sameRenderInputs(base, { ...base, window: { t0: 0, t1: 2 } })).toBe(
      false,
    );
    expect(sameRenderInputs(base, { ...base, missingEmpty: false })).toBe(
      false,
    );
  });

  it("parses trusted drag payload shapes without throwing", () => {
    expect(
      parseSignalPayload(JSON.stringify({ paths: ["a/temp", "b/temp"] })),
    ).toEqual(["a/temp", "b/temp"]);
    expect(parseSignalPayload("a/temp")).toEqual(["a/temp"]);
    expect(parseSignalPayload(JSON.stringify({ paths: [1] }))).toEqual([]);
    expect(
      parseSignalRefsPayload(
        JSON.stringify({ refs: [{ source_key: "a", channel: "temp" }] }),
      ),
    ).toEqual([{ source_key: "a", channel: "temp" }]);
    expect(parseSetPayload(JSON.stringify({ set_id: "set-1" }))).toBe("set-1");
  });

  it("keeps the panel's keyboard-safe maximize glyph", () => {
    expect(MAXIMIZE_GLYPH).toBe("↗");
  });

  it("reads drag data only when a non-empty value exists", () => {
    const event = {
      dataTransfer: {
        getData: (type: string) => (type === "signal" ? "a/temp" : ""),
      },
    } as unknown as DragEvent;
    expect(dragData(event, "signal")).toBe("a/temp");
    expect(dragData(event, "set")).toBeNull();
  });
});
