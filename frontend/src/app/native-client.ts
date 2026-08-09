import type { FileWriteMetadata, TileRequest } from "../generated/protocol";
import type { NativeConnection } from "./desktop-bridge";
import type { Envelope } from "./envelope";
import { createFileFrameStream } from "./file-binary";

interface NativeErrorBody {
  transport_version: 1;
  code: string;
  message: string;
}

type NativeRequestInit = RequestInit & { duplex?: "half" };

export class NativeClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "NativeClientError";
  }
}

function validatePath(path: string): URL {
  const url = new URL(path, "http://127.0.0.1/");
  if (
    !path.startsWith("/v1/") ||
    !url.pathname.startsWith("/v1/") ||
    url.origin !== "http://127.0.0.1"
  ) {
    throw new Error("native route must be under /v1/");
  }
  return url;
}

function validateConnection(connection: NativeConnection): NativeConnection {
  const url = new URL(connection.baseUrl);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/"
  ) {
    throw new Error("native connection must use loopback HTTP");
  }
  if (!Number.isInteger(connection.protocolVersion)) {
    throw new Error("native connection has an unsupported version");
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(connection.token)) {
    throw new Error("native connection has an invalid token");
  }
  return Object.freeze({ ...connection });
}

export class NativeClient {
  private readonly connection: NativeConnection;
  private readonly fetchFn: typeof fetch;

  constructor(
    connection: NativeConnection,
    fetchFn: typeof fetch = (input, init) => fetch(input, init),
  ) {
    this.connection = validateConnection(connection);
    this.fetchFn = fetchFn;
  }

  async json<Req, Res>(
    path: string,
    request: Envelope<Req>,
  ): Promise<Envelope<Res>> {
    const response = await this.fetchRequest(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    return (await response.json()) as Envelope<Res>;
  }

  async tiles(request: Envelope<TileRequest>): Promise<ArrayBuffer> {
    const response = await this.fetchRequest("/v1/query/tiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    return response.arrayBuffer();
  }

  async writeFile(
    metadata: Envelope<FileWriteMetadata>,
    bytes: Uint8Array,
  ): Promise<Envelope<string>> {
    const response = await this.fetchRequest("/v1/export/file", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: createFileFrameStream(metadata, bytes) as BodyInit,
      duplex: "half",
    });
    return (await response.json()) as Envelope<string>;
  }

  private async fetchRequest(
    path: string,
    init: NativeRequestInit,
  ): Promise<Response> {
    const route = validatePath(path);
    const url = new URL(route.pathname + route.search, this.connection.baseUrl);
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.connection.token}`);
    const response = await this.fetchFn(url, {
      ...init,
      headers,
    } as RequestInit);
    if (response.ok) return response;
    let error: NativeErrorBody | null = null;
    try {
      error = (await response.json()) as NativeErrorBody;
    } catch {
      // Preserve the HTTP status when the server did not return its envelope.
    }
    throw new NativeClientError(
      response.status,
      error?.code ?? "native_http_error",
      error?.message ?? `native host returned HTTP ${String(response.status)}`,
    );
  }
}
