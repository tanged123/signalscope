import {
  PROTOCOL_VERSION,
  type FileWriteMetadata,
} from "../generated/protocol";
import type { Envelope } from "./envelope";

const MAGIC = 0x57465353;
const HEADER_BYTES = 24;

export class FileBinaryError extends Error {}

export function encodeFileFrame(
  metadata: Envelope<FileWriteMetadata>,
  bytes: Uint8Array,
): Uint8Array {
  const encodedMetadata = new TextEncoder().encode(JSON.stringify(metadata));
  if (encodedMetadata.length > 0xffffffff)
    throw new FileBinaryError("metadata is too large");
  const frame = new Uint8Array(
    HEADER_BYTES + encodedMetadata.length + bytes.length,
  );
  const view = new DataView(frame.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, PROTOCOL_VERSION, true);
  view.setUint32(8, encodedMetadata.length, true);
  view.setUint32(12, 0, true);
  view.setBigUint64(16, BigInt(bytes.length), true);
  frame.set(encodedMetadata, HEADER_BYTES);
  frame.set(bytes, HEADER_BYTES + encodedMetadata.length);
  return frame;
}

export function decodeFileFrame(frame: Uint8Array): {
  metadata: Envelope<FileWriteMetadata>;
  bytes: Uint8Array;
} {
  if (frame.byteLength < HEADER_BYTES)
    throw new FileBinaryError("file frame is truncated");
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  if (view.getUint32(0, true) !== MAGIC)
    throw new FileBinaryError("file frame has the wrong magic");
  if (view.getUint32(4, true) !== PROTOCOL_VERSION) {
    throw new FileBinaryError("file frame has the wrong protocol version");
  }
  if (view.getUint32(12, true) !== 0)
    throw new FileBinaryError("file frame length is invalid");
  const metadataLength = view.getUint32(8, true);
  const payloadLength = view.getBigUint64(16, true);
  if (payloadLength > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new FileBinaryError("file frame length is invalid");
  }
  const metadataEnd = HEADER_BYTES + metadataLength;
  const payloadEnd = metadataEnd + Number(payloadLength);
  if (!Number.isSafeInteger(payloadEnd))
    throw new FileBinaryError("file frame length is invalid");
  if (frame.byteLength < payloadEnd)
    throw new FileBinaryError("file frame is truncated");
  if (frame.byteLength !== payloadEnd)
    throw new FileBinaryError("file frame has trailing bytes");
  let metadata: Envelope<FileWriteMetadata>;
  try {
    metadata = JSON.parse(
      new TextDecoder().decode(frame.subarray(HEADER_BYTES, metadataEnd)),
    ) as Envelope<FileWriteMetadata>;
  } catch {
    throw new FileBinaryError("file frame metadata is invalid");
  }
  return { metadata, bytes: frame.slice(metadataEnd, payloadEnd) };
}
