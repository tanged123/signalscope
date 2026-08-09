import { describe, expect, it } from "vitest";
import { parseHandshake } from "../src/backend";

const token = "A".repeat(43);

describe("native host handshake", () => {
  it("accepts the loopback connection record", () => {
    expect(
      parseHandshake(
        JSON.stringify({
          transport_version: 1,
          port: 43817,
          token,
          protocol_version: 22,
        }),
      ),
    ).toEqual({
      transportVersion: 1,
      baseUrl: "http://127.0.0.1:43817",
      token,
      protocolVersion: 22,
    });
  });

  it.each([
    ["bad JSON", "{"],
    ["wrong transport", JSON.stringify({ transport_version: 2 })],
    [
      "invalid port",
      JSON.stringify({
        transport_version: 1,
        port: 0,
        token,
        protocol_version: 22,
      }),
    ],
    [
      "invalid token",
      JSON.stringify({
        transport_version: 1,
        port: 1,
        token: "short",
        protocol_version: 22,
      }),
    ],
  ])("rejects %s", (_label, value) => {
    expect(() => parseHandshake(value)).toThrow();
  });
});
