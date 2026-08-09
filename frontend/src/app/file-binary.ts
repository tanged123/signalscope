import {
  PROTOCOL_VERSION,
  type FileWriteMetadata,
} from "../generated/protocol";
import type { Envelope } from "./envelope";

const MAGIC = 0x57465353;
export const FILE_FRAME_HEADER_BYTES = 24;
export const FILE_FRAME_METADATA_LIMIT = 1024 * 1024;
export const FILE_FRAME_PAYLOAD_LIMIT = 1024 * 1024 * 1024;
const PAYLOAD_CHUNK_BYTES = 64 * 1024;

export interface FileFrameHeader {
  readonly metadataLength: number;
  readonly payloadLength: bigint;
}

export class FileBinaryError extends Error {}

export function encodeFileFrame(
  metadata: Envelope<FileWriteMetadata>,
  bytes: Uint8Array,
): Uint8Array {
  const encodedMetadata = new TextEncoder().encode(JSON.stringify(metadata));
  if (encodedMetadata.length > FILE_FRAME_METADATA_LIMIT)
    throw new FileBinaryError("metadata is too large");
  if (bytes.length > FILE_FRAME_PAYLOAD_LIMIT)
    throw new FileBinaryError("payload is too large");
  const frame = new Uint8Array(
    FILE_FRAME_HEADER_BYTES + encodedMetadata.length + bytes.length,
  );
  const view = new DataView(frame.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, PROTOCOL_VERSION, true);
  view.setUint32(8, encodedMetadata.length, true);
  view.setUint32(12, 0, true);
  view.setBigUint64(16, BigInt(bytes.length), true);
  frame.set(encodedMetadata, FILE_FRAME_HEADER_BYTES);
  frame.set(bytes, FILE_FRAME_HEADER_BYTES + encodedMetadata.length);
  return frame;
}

export function createFileFrameStream(
  metadata: Envelope<FileWriteMetadata>,
  bytes: Uint8Array,
): ReadableStream<Uint8Array> {
  const encodedMetadata = new TextEncoder().encode(JSON.stringify(metadata));
  if (encodedMetadata.length > FILE_FRAME_METADATA_LIMIT)
    throw new FileBinaryError("metadata is too large");
  if (bytes.length > FILE_FRAME_PAYLOAD_LIMIT)
    throw new FileBinaryError("payload is too large");
  const header = new Uint8Array(FILE_FRAME_HEADER_BYTES);
  const view = new DataView(header.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, PROTOCOL_VERSION, true);
  view.setUint32(8, encodedMetadata.length, true);
  view.setUint32(12, 0, true);
  view.setBigUint64(16, BigInt(bytes.length), true);
  let headerOffset = 0;
  let metadataOffset = 0;
  let payloadOffset = 0;
  return new ReadableStream({
    pull(controller) {
      if (headerOffset < header.length) {
        controller.enqueue(header.subarray(headerOffset));
        headerOffset = header.length;
        return;
      }
      if (metadataOffset < encodedMetadata.length) {
        controller.enqueue(encodedMetadata.subarray(metadataOffset));
        metadataOffset = encodedMetadata.length;
        return;
      }
      if (payloadOffset < bytes.length) {
        const end = Math.min(payloadOffset + PAYLOAD_CHUNK_BYTES, bytes.length);
        controller.enqueue(bytes.subarray(payloadOffset, end));
        payloadOffset = end;
        return;
      }
      controller.close();
    },
  });
}

export function decodeFileFrameHeader(bytes: Uint8Array): FileFrameHeader {
  if (bytes.byteLength < FILE_FRAME_HEADER_BYTES)
    throw new FileBinaryError("file frame is truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC)
    throw new FileBinaryError("file frame has the wrong magic");
  if (view.getUint32(4, true) !== PROTOCOL_VERSION)
    throw new FileBinaryError("file frame has the wrong protocol version");
  if (view.getUint32(12, true) !== 0)
    throw new FileBinaryError("file frame length is invalid");
  const metadataLength = view.getUint32(8, true);
  const payloadLength = view.getBigUint64(16, true);
  if (
    metadataLength > FILE_FRAME_METADATA_LIMIT ||
    payloadLength > BigInt(FILE_FRAME_PAYLOAD_LIMIT)
  )
    throw new FileBinaryError("file frame length is invalid");
  return { metadataLength, payloadLength };
}

export function decodeFileFrameMetadata(
  header: FileFrameHeader,
  bytes: Uint8Array,
): Envelope<FileWriteMetadata> {
  if (bytes.byteLength !== header.metadataLength)
    throw new FileBinaryError(
      bytes.byteLength < header.metadataLength
        ? "file frame is truncated"
        : "file frame has trailing bytes",
    );
  try {
    return JSON.parse(
      new TextDecoder().decode(bytes),
    ) as Envelope<FileWriteMetadata>;
  } catch {
    throw new FileBinaryError("file frame metadata is invalid");
  }
}

export function decodeFileFrame(frame: Uint8Array): {
  metadata: Envelope<FileWriteMetadata>;
  bytes: Uint8Array;
} {
  const header = decodeFileFrameHeader(frame);
  const metadataEnd = FILE_FRAME_HEADER_BYTES + header.metadataLength;
  const payloadEnd = metadataEnd + Number(header.payloadLength);
  if (frame.byteLength < payloadEnd)
    throw new FileBinaryError("file frame is truncated");
  if (frame.byteLength !== payloadEnd)
    throw new FileBinaryError("file frame has trailing bytes");
  const metadata = decodeFileFrameMetadata(
    header,
    frame.subarray(FILE_FRAME_HEADER_BYTES, metadataEnd),
  );
  return { metadata, bytes: frame.slice(metadataEnd, payloadEnd) };
}
