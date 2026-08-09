import { describe, expect, it } from "vitest";
import type { FileWriteMetadata } from "../generated/protocol";
import { seal } from "./envelope";
import {
  createFileFrameStream,
  decodeFileFrame,
  decodeFileFrameHeader,
  decodeFileFrameMetadata,
  encodeFileFrame,
} from "./file-binary";

const metadata = seal<FileWriteMetadata>({
  destination: "directory",
  path: "/tmp/é",
  file_name: "plot.png",
  kind: "png",
});

describe("native file frame", () => {
  it("round-trips Unicode metadata and binary bytes", () => {
    const bytes = new Uint8Array([0, 1, 255]);
    const decoded = decodeFileFrame(encodeFileFrame(metadata, bytes));
    expect(decoded.metadata).toEqual(metadata);
    expect(decoded.bytes).toEqual(bytes);
  });

  it("rejects truncation, wrong headers, and trailing bytes", () => {
    const frame = encodeFileFrame(metadata, new Uint8Array([1, 2, 3]));
    for (let length = 0; length < 24; length += 1) {
      expect(() => decodeFileFrame(frame.slice(0, length))).toThrow();
    }
    const wrongMagic = frame.slice();
    wrongMagic[0] = (wrongMagic[0] ?? 0) ^ 1;
    expect(() => decodeFileFrame(wrongMagic)).toThrow();
    expect(() => decodeFileFrame(new Uint8Array([...frame, 0]))).toThrow();
  });

  it("streams the header, metadata, and bounded payload slices", async () => {
    const bytes = new Uint8Array(150_000);
    bytes.forEach((_, index) => bytes.set([index % 251], index));
    const source = bytes.slice();
    const reader = createFileFrameStream(metadata, bytes).getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
    }
    expect(bytes).toEqual(source);
    expect(chunks.slice(2).every((chunk) => chunk.length <= 64 * 1024)).toBe(
      true,
    );
    const frame = new Uint8Array(
      chunks.reduce((length, chunk) => length + chunk.length, 0),
    );
    let offset = 0;
    for (const chunk of chunks) {
      frame.set(chunk, offset);
      offset += chunk.length;
    }
    const header = decodeFileFrameHeader(frame);
    expect(
      decodeFileFrameMetadata(
        header,
        frame.subarray(24, 24 + header.metadataLength),
      ),
    ).toEqual(metadata);
    expect(decodeFileFrame(frame).bytes).toEqual(bytes);
  });
});
