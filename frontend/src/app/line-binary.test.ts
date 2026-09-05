import { describe, expect, it, vi } from "vitest";
import type { Line2DRequest } from "../generated/protocol";
import { HttpPlane } from "./data-plane";
import type { Envelope } from "./envelope";
import { decodeLineResponse } from "./line-binary";

const MAGIC = 0x324c5353;

function fixture(): ArrayBuffer {
  const bytes: number[] = [];
  const pushU16 = (value: number) =>
    pushBytes(new Uint8Array(new Uint16Array([value]).buffer));
  const pushU32 = (value: number) => {
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, value, true);
    pushBytes(new Uint8Array(view.buffer));
  };
  const pushU64 = (value: bigint) => {
    const view = new DataView(new ArrayBuffer(8));
    view.setBigUint64(0, value, true);
    pushBytes(new Uint8Array(view.buffer));
  };
  const pushF64 = (value: number) => {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, true);
    pushBytes(new Uint8Array(view.buffer));
  };
  const pushBytes = (values: Uint8Array) => {
    bytes.push(...values);
  };
  const pushMetadata = (id: bigint, path: string, unit: string | null) => {
    const pathBytes = new TextEncoder().encode(path);
    const unitBytes = unit === null ? null : new TextEncoder().encode(unit);
    pushU64(id);
    pushU16(pathBytes.byteLength);
    pushU16(unitBytes?.byteLength ?? 0xffff);
    pushU32(0);
    pushBytes(pathBytes);
    if (unitBytes !== null) pushBytes(unitBytes);
    while (bytes.length % 8 !== 0) bytes.push(0);
  };

  pushU32(MAGIC);
  pushU32(1);
  pushU32(3);
  pushU32(2);
  pushU32(3);
  pushU32(0);
  pushMetadata(0x20000000000001n, "run/x", "s");
  pushMetadata(0x20000000000002n, "run/y0", "V");
  pushMetadata(0x20000000000003n, "run/y1", null);
  for (const value of [0, 1, 2]) pushF64(value);
  for (const value of [10, Number.NaN, 12]) pushF64(value);
  for (const value of [20, 21, 22]) pushF64(value);
  for (const value of [30, 31, Number.NaN]) pushF64(value);
  return new Uint8Array(bytes).buffer;
}

function viewOfFixture(): DataView {
  return new DataView(fixture());
}

describe("decodeLineResponse", () => {
  it("preserves paired rows, metadata order, gaps, and exact IDs", () => {
    const response = decodeLineResponse(fixture(), "line-request");

    expect(response.requestId).toBe("line-request");
    expect(response.level).toBe(3);
    expect(Array.from(response.anchor)).toEqual([0, 1, 2]);
    expect(response.x.signalId).toBe("9007199254740993");
    expect(response.x.signalPath).toBe("run/x");
    expect(response.x.unit).toBe("s");
    expect(
      Array.from(response.x.values, (value) => Number.isNaN(value)),
    ).toEqual([false, true, false]);
    expect(response.ys.map((column) => column.signalId)).toEqual([
      "9007199254740994",
      "9007199254740995",
    ]);
    expect(response.ys[0]?.unit).toBe("V");
    expect(response.ys[1]?.unit).toBeNull();
    expect(Array.from(response.ys[1]?.values ?? [])).toEqual([30, 31, NaN]);
  });

  it.each([
    ["bad magic", (view: DataView) => view.setUint32(0, 0, true), "magic"],
    ["bad version", (view: DataView) => view.setUint32(4, 2, true), "version"],
    [
      "reserved header",
      (view: DataView) => view.setUint32(20, 1, true),
      "reserved header",
    ],
    [
      "empty Y columns",
      (view: DataView) => view.setUint32(12, 0, true),
      "no Y",
    ],
  ] as const)("rejects %s", (_name, mutate, message) => {
    const view = viewOfFixture();
    mutate(view);
    expect(() =>
      decodeLineResponse(view.buffer as ArrayBuffer, "request"),
    ).toThrow(message);
  });

  it("rejects truncation, trailing bytes, invalid UTF-8, and reserved metadata", () => {
    const source = new Uint8Array(fixture());
    expect(() =>
      decodeLineResponse(source.slice(0, -1).buffer, "request"),
    ).toThrow("truncated");

    const trailing = new Uint8Array(source.byteLength + 1);
    trailing.set(source);
    expect(() => decodeLineResponse(trailing.buffer, "request")).toThrow(
      "trailing",
    );

    const invalidUtf8 = source.slice();
    invalidUtf8[40] = 0xff;
    expect(() => decodeLineResponse(invalidUtf8.buffer, "request")).toThrow(
      "UTF-8",
    );

    const reservedMetadata = source.slice();
    new DataView(reservedMetadata.buffer).setUint32(36, 1, true);
    expect(() =>
      decodeLineResponse(reservedMetadata.buffer, "request"),
    ).toThrow("reserved metadata");

    const nonzeroPadding = source.slice();
    nonzeroPadding[46] = 1;
    expect(() => decodeLineResponse(nonzeroPadding.buffer, "request")).toThrow(
      "metadata padding",
    );
  });

  it("rejects unsafe count multiplication before allocating columns", () => {
    const bytes = new Uint8Array(24);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, MAGIC, true);
    view.setUint32(4, 1, true);
    view.setUint32(12, 0xffffffff, true);
    view.setUint32(16, 0xffffffff, true);
    expect(() => decodeLineResponse(bytes.buffer, "request")).toThrow("unsafe");
  });
});

describe("HttpPlane.queryLine2D", () => {
  it("posts an enveloped request and decodes the binary response", async () => {
    const request: Line2DRequest = {
      request_id: "line-request",
      x_signal_id: "9007199254740993",
      y_signal_ids: ["9007199254740994", "9007199254740995"],
      window: { t0: 0, t1: 2 },
      pixel_width: 640,
    };
    const fetcher = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        expect(input).toBe("/api/query_line2d_bin");
        if (typeof init?.body !== "string") throw new Error("missing body");
        const body = JSON.parse(init.body) as Envelope<Line2DRequest>;
        expect(body.payload).toEqual(request);
        return Promise.resolve(
          new Response(fixture(), {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          }),
        );
      },
    );

    const response = await new HttpPlane(fetcher as typeof fetch).queryLine2D(
      request,
    );

    expect(response.requestId).toBe(request.request_id);
    expect(response.x.signalId).toBe(request.x_signal_id);
    expect(response.ys.map((column) => column.signalId)).toEqual(
      request.y_signal_ids,
    );
  });
});
