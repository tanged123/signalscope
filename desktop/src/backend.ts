import { spawn, type ChildProcessByStdio } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { totalmem } from "node:os";
import type { Readable, Writable } from "node:stream";
import type { BackendPaths, NativeConnection } from "./types";

const TRANSPORT_VERSION = 1;
const HANDSHAKE_LIMIT = 8192;
const START_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 5_000;

interface Handshake {
  transport_version: number;
  port: number;
  token: string;
  protocol_version: number;
}

type NativeChild = ChildProcessByStdio<Writable, Readable, null>;

function executableIsValid(path: string): Promise<void> {
  if (!isAbsolute(path))
    throw new Error("native host executable must be absolute");
  return stat(path).then((entry) => {
    if (!entry.isFile())
      throw new Error("native host executable is not a file");
  });
}

function parseHandshake(line: string): NativeConnection {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("native host handshake is not valid JSON");
  }
  if (value === null || typeof value !== "object") {
    throw new Error("native host handshake is not an object");
  }
  const handshake = value as Partial<Handshake>;
  if (handshake.transport_version !== TRANSPORT_VERSION) {
    throw new Error(
      "native host handshake has an unsupported transport version",
    );
  }
  const port = handshake.port;
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error("native host handshake has an invalid loopback port");
  }
  if (
    typeof handshake.token !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(handshake.token)
  ) {
    throw new Error("native host handshake has an invalid bearer token");
  }
  const protocolVersion = handshake.protocol_version;
  if (
    typeof protocolVersion !== "number" ||
    !Number.isInteger(protocolVersion) ||
    protocolVersion < 1
  ) {
    throw new Error("native host handshake has an invalid protocol version");
  }
  return {
    transportVersion: 1,
    baseUrl: `http://127.0.0.1:${String(port)}`,
    token: handshake.token,
    protocolVersion,
  };
}

export class BackendProcess {
  private constructor(
    private readonly child: NativeChild,
    private readonly nativeConnection: NativeConnection,
  ) {}

  static async start(
    paths: BackendPaths,
    devOrigin: string | null,
  ): Promise<BackendProcess> {
    await executableIsValid(paths.executable);
    const args = [
      "--config-dir",
      paths.configDir,
      "--cache-dir",
      paths.cacheDir,
      "--resource-dir",
      paths.resourceDir,
      "--available-memory",
      String(totalmem()),
    ];
    if (devOrigin !== null) args.push("--dev-origin", devOrigin);
    const child = spawn(paths.executable, args, {
      detached: false,
      stdio: ["pipe", "pipe", "inherit"],
    });
    try {
      const connection = await readHandshake(child);
      return new BackendProcess(child, connection);
    } catch (error) {
      child.kill();
      throw error;
    }
  }

  connection(): NativeConnection {
    return this.nativeConnection;
  }

  private stopPromise: Promise<void> | null = null;

  stop(): Promise<void> {
    this.stopPromise ??= new Promise<void>((resolveStop) => {
      if (this.child.exitCode !== null) {
        resolveStop();
        return;
      }
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        resolveStop();
      };
      this.child.once("exit", settle);
      const killTimer = setTimeout(() => {
        if (!settled) {
          this.child.kill();
          settle();
        }
      }, STOP_TIMEOUT_MS);
      this.child.stdin.end();
    });
    return this.stopPromise;
  }
}

function readHandshake(child: NativeChild): Promise<NativeConnection> {
  return new Promise((resolveConnection, reject) => {
    let data = "";
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const settleError = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(message));
    };
    timeout = setTimeout(
      () => settleError("native host handshake timed out"),
      START_TIMEOUT_MS,
    );
    child.stdout.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      data += chunk.toString();
      if (Buffer.byteLength(data, "utf8") > HANDSHAKE_LIMIT) {
        settleError("native host handshake exceeds 8 KiB");
        return;
      }
      const newline = data.indexOf("\n");
      if (newline < 0) return;
      const line = data.slice(0, newline).trim();
      try {
        const connection = parseHandshake(line);
        settled = true;
        clearTimeout(timeout);
        resolveConnection(connection);
      } catch (error) {
        settleError(error instanceof Error ? error.message : String(error));
      }
    });
    child.once("error", (error) =>
      settleError(`native host failed to start: ${error.message}`),
    );
    child.once("exit", () =>
      settleError("native host exited before handshake"),
    );
  });
}

export { parseHandshake };
