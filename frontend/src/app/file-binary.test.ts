import { describe, expect, it } from "vitest";
import type { FileWriteMetadata } from "../generated/protocol";
import { seal } from "./envelope";
import { decodeFileFrame, encodeFileFrame } from "./file-binary";

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
});
