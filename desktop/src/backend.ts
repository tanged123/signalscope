import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

const START_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 5_000;
const OUTPUT_LIMIT = 8192;

export interface BackendPaths {
  readonly executable: string;
  readonly frontend: string;
  readonly data: string;
}

type SpawnBackend = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export function backendArguments(paths: BackendPaths): string[] {
  return [
    "--port",
    "0",
    "--no-open",
    "--exit-on-stdin-close",
    "--frontend-dir",
    paths.frontend,
    "--data-dir",
    paths.data,
  ];
}

export function parseLaunchUrl(line: string): string {
  let url: URL;
  try {
    url = new URL(line);
  } catch {
    throw new Error("scope-server returned an invalid launch URL");
  }
  const token = url.searchParams.get("token");
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.port.length === 0 ||
    Number(url.port) < 1 ||
    Number(url.port) > 65535 ||
    url.pathname !== "/" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0 ||
    [...url.searchParams.keys()].some((key) => key !== "token") ||
    token === null ||
    !/^[0-9a-f]{32}$/.test(token)
  ) {
    throw new Error("scope-server returned an unsafe launch URL");
  }
  return url.toString();
}

async function requireFile(path: string, label: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute`);
  const entry = await stat(path).catch(() => null);
  if (entry === null || !entry.isFile())
    throw new Error(`${label} is missing: ${path}`);
}

async function requireDirectory(path: string, label: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute`);
  const entry = await stat(path).catch(() => null);
  if (entry === null || !entry.isDirectory())
    throw new Error(`${label} is missing: ${path}`);
}

export class BackendProcess {
  private stopPromise: Promise<void> | null = null;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    readonly launchUrl: string,
    private readonly exit: Promise<{
      code: number | null;
      signal: string | null;
    }>,
  ) {}

  static async start(
    paths: BackendPaths,
    spawnBackend: SpawnBackend = spawn,
  ): Promise<BackendProcess> {
    await Promise.all([
      requireFile(paths.executable, "scope-server"),
      requireDirectory(paths.frontend, "frontend"),
    ]);
    const child = spawnBackend(paths.executable, backendArguments(paths), {
      detached: false,
      windowsHide: true,
    });
    const exit = new Promise<{ code: number | null; signal: string | null }>(
      (resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );
    try {
      const launchUrl = await readLaunchUrl(child);
      return new BackendProcess(child, launchUrl, exit);
    } catch (error) {
      child.kill();
      throw error;
    }
  }

  exited(): Promise<{ code: number | null; signal: string | null }> {
    return this.exit;
  }

  stop(): Promise<void> {
    this.stopPromise ??= new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        resolve();
        return;
      }
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        resolve();
      };
      const killTimer = setTimeout(() => {
        this.child.kill();
        settle();
      }, STOP_TIMEOUT_MS);
      this.child.once("exit", settle);
      this.child.stdin.end();
    });
    return this.stopPromise;
  }
}

function readLaunchUrl(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(
      () => fail("scope-server startup timed out"),
      START_TIMEOUT_MS,
    );
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const detail = stderr.trim();
      reject(
        new Error(detail.length === 0 ? message : `${message}: ${detail}`),
      );
    };
    child.stderr.on("data", (chunk: Buffer | string) => {
      if (Buffer.byteLength(stderr, "utf8") < OUTPUT_LIMIT)
        stderr += chunk.toString();
    });
    child.stdout.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout, "utf8") > OUTPUT_LIMIT) {
        fail("scope-server launch output exceeds 8 KiB");
        return;
      }
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      try {
        const launchUrl = parseLaunchUrl(stdout.slice(0, newline).trim());
        settled = true;
        clearTimeout(timeout);
        resolve(launchUrl);
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    });
    child.once("error", (error) =>
      fail(`scope-server failed to start: ${error.message}`),
    );
    child.once("exit", () => fail("scope-server exited during startup"));
  });
}
