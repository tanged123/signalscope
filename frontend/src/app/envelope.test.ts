import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../generated/protocol";
import { open, seal } from "./envelope";

describe("envelope", () => {
  it("round-trips a payload at the current version", () => {
    expect(open(seal({ value: 42 }))).toEqual({ value: 42 });
  });

  it("rejects a mismatched version", () => {
    expect(() =>
      open({ protocol_version: PROTOCOL_VERSION + 1, payload: null }),
    ).toThrow(/unsupported protocol version/i);
  });
});
