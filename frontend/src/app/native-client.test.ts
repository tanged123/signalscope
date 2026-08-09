import { describe, expect, it, vi } from "vitest";
import type { TileRequest } from "../generated/protocol";
import { seal } from "./envelope";
import { decodeFileFrame } from "./file-binary";
import { NativeClient, type NativeFileWriter } from "./native-client";

const token = "A".repeat(43);
const connection = {
  transportVersion: 1 as const,
  baseUrl: "http://127.0.0.1:43817",
  token,
  protocolVersion: 22,
};

describe("NativeClient", () => {
  it("adds bearer authentication and preserves JSON envelopes", async () => {
    const fetchFn = vi.fn<typeof fetch>((_input, init) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        `Bearer ${token}`,
      );
      return Promise.resolve(
        new Response(JSON.stringify(seal({ ok: true })), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
    const client = new NativeClient(connection, fetchFn);
    await expect(
      client.json("/v1/catalog/formats", seal(null)),
    ).resolves.toEqual(seal({ ok: true }));
    const input = fetchFn.mock.calls[0]?.[0];
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input?.url;
    expect(url).toBe("http://127.0.0.1:43817/v1/catalog/formats");
  });

  it("uses binary transport for tiles and raw file writes", async () => {
    const tile: TileRequest = {
      request_id: "r",
      signal_ids: [],
      window: { t0: 0, t1: 1 },
      pixel_width: 10,
    };
    const fetchFn = vi.fn<typeof fetch>((_input, init) => {
      const body = init?.body;
      if (body instanceof ReadableStream) {
        expect((init as RequestInit & { duplex?: string }).duplex).toBe("half");
        return new Response(body).arrayBuffer().then((buffer) => {
          const frame = decodeFileFrame(new Uint8Array(buffer));
          expect(frame.bytes).toEqual(new Uint8Array([1, 2]));
          return new Response(JSON.stringify(seal("/tmp/plot.png")), {
            status: 200,
          });
        });
      }
      if (body instanceof Uint8Array) {
        const frame = decodeFileFrame(body);
        expect(frame.bytes).toEqual(new Uint8Array([1, 2]));
      }
      return Promise.resolve(
        new Response(JSON.stringify(seal("/tmp/plot.png")), {
          status: 200,
        }),
      );
    });
    const client = new NativeClient(connection, fetchFn);
    await client.tiles(seal(tile));
    await client.writeFile(
      seal({
        destination: "exact_path",
        path: "/tmp/plot.png",
        file_name: "",
        kind: "png",
      }),
      new Uint8Array([1, 2]),
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("decodes safe native errors without exposing the token", async () => {
    const fetchFn = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            transport_version: 1,
            code: "invalid_request",
            message: "bad input",
          }),
          { status: 400 },
        ),
      ),
    );
    const client = new NativeClient(connection, fetchFn);
    await expect(
      client.json("/v1/catalog/formats", seal(null)),
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid_request",
      message: "bad input",
    });
  });

  it("streams native file frames through the Electron writer", async () => {
    const chunks: Uint8Array[] = [];
    const abortFileWrite = vi.fn(() => Promise.resolve());
    const writer: NativeFileWriter = {
      abortFileWrite,
      beginFileWrite: vi.fn(() => Promise.resolve("write-1")),
      finishFileWrite: vi.fn(() =>
        Promise.resolve({
          body: JSON.stringify(seal("/tmp/plot.png")),
          status: 200,
        }),
      ),
      writeFileChunk: vi.fn<NativeFileWriter["writeFileChunk"]>(
        (_id, chunk) => {
          chunks.push(chunk.slice());
          return Promise.resolve();
        },
      ),
    };
    const client = new NativeClient(connection, undefined, writer);
    await expect(
      client.writeFile(
        seal({
          destination: "exact_path",
          path: "/tmp/plot.png",
          file_name: "",
          kind: "png",
        }),
        new Uint8Array([1, 2]),
      ),
    ).resolves.toEqual(seal("/tmp/plot.png"));
    const frame = new Uint8Array(
      chunks.reduce((total, chunk) => total + chunk.length, 0),
    );
    let offset = 0;
    for (const chunk of chunks) {
      frame.set(chunk, offset);
      offset += chunk.length;
    }
    expect(decodeFileFrame(frame).bytes).toEqual(new Uint8Array([1, 2]));
    expect(abortFileWrite).not.toHaveBeenCalled();
  });
});
