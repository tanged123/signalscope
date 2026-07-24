import { PROTOCOL_VERSION } from "../generated/protocol";

export interface Envelope<T> {
  protocol_version: number;
  payload: T;
}

export function seal<T>(payload: T): Envelope<T> {
  return { protocol_version: PROTOCOL_VERSION, payload };
}

export function open<T>(envelope: Envelope<T>): T {
  if (envelope.protocol_version !== PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported protocol version ${String(envelope.protocol_version)}; expected ${String(PROTOCOL_VERSION)}`,
    );
  }
  return envelope.payload;
}
