import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  backendArguments,
  BackendProcess,
  parseLaunchUrl,
  type BackendPaths,
} from "../src/backend";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function paths(): Promise<BackendPaths> {
  const root = await mkdtemp(join(tmpdir(), "signalscope-desktop-"));
  roots.push(root);
  const executable = join(root, "scope-server");
  const frontend = join(root, "frontend");
  await writeFile(executable, "server");
  await mkdir(frontend);
  return { executable, frontend, data: join(root, "data") };
}

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    signalCode: string | null;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn(() => true);
  return child;
}

describe("scope-server lifecycle", () => {
  it("uses only the loopback server arguments", async () => {
    const backendPaths = await paths();
    expect(backendArguments(backendPaths)).toEqual([
      "--port",
      "0",
      "--no-open",
      "--exit-on-stdin-close",
      "--frontend-dir",
      backendPaths.frontend,
      "--data-dir",
      backendPaths.data,
    ]);
  });

  it("starts from a validated authenticated URL and closes stdin to stop", async () => {
    const backendPaths = await paths();
    const child = fakeChild();
    const spawn = vi.fn(() => child as never);
    const starting = BackendProcess.start(backendPaths, spawn);
    child.stdout.write(
      "http://127.0.0.1:43817/?token=0123456789abcdef0123456789abcdef\n",
    );
    const backend = await starting;
    expect(backend.launchUrl).toBe(
      "http://127.0.0.1:43817/?token=0123456789abcdef0123456789abcdef",
    );
    expect(spawn).toHaveBeenCalledWith(
      backendPaths.executable,
      backendArguments(backendPaths),
      { detached: false, windowsHide: true },
    );
    const stopped = backend.stop();
    expect(child.stdin.writableEnded).toBe(true);
    child.emit("exit", 0, null);
    await stopped;
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each([
    "https://127.0.0.1:43817/?token=0123456789abcdef0123456789abcdef",
    "http://localhost:43817/?token=0123456789abcdef0123456789abcdef",
    "http://127.0.0.1:43817/",
    "http://127.0.0.1:43817/?token=short",
    "http://127.0.0.1:43817/?token=0123456789abcdef0123456789abcdef&extra=1",
  ])("rejects unsafe launch URL %s", (url) => {
    expect(() => parseLaunchUrl(url)).toThrow(/unsafe/);
  });
});
