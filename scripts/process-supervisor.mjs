import { closeSync, openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const READINESS_TIMEOUT_MS = 10_000;
const TERMINATION_GRACE_MS = 500;

function commandText(spec) {
  return [spec.command, ...(spec.args ?? [])]
    .map((argument) => JSON.stringify(argument))
    .join(" ");
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function portIsOpen(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function spawnCommand(spec, stdio) {
  const child = spawn(spec.command, spec.args ?? [], {
    cwd: spec.cwd,
    detached: process.platform !== "win32",
    env: spec.env ? { ...process.env, ...spec.env } : process.env,
    stdio,
    windowsHide: true,
  });
  spec.onSpawn?.(child);
  return child;
}

async function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await waitForExit(killer);
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  const stopped = await Promise.race([
    waitForExit(child),
    delay(TERMINATION_GRACE_MS),
  ]);
  if (
    stopped === undefined &&
    child.exitCode === null &&
    child.signalCode === null
  ) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    await waitForExit(child);
  }
}

async function waitUntilReady({ child, server, host, port, logPath, signal }) {
  const exited = waitForExit(child);
  const started = Date.now();
  while (Date.now() - started < READINESS_TIMEOUT_MS) {
    if (await portIsOpen(host, port)) return;
    const result = await Promise.race([
      exited,
      signal,
      delay(50).then(() => null),
    ]);
    if (result?.kind === "signal") return result;
    if (result && result.kind !== "signal") {
      const status = result.error
        ? result.error.message
        : `exit ${result.code ?? `signal ${result.signal}`}`;
      throw new Error(
        `server ${commandText(server)} ${status}; log: ${logPath}`,
      );
    }
  }
  throw new Error(
    `server ${commandText(server)} did not open ${host}:${port}; log: ${logPath}`,
  );
}

export async function supervise({
  server,
  foreground,
  host = "127.0.0.1",
  port,
  logPath,
}) {
  if (await portIsOpen(host, port)) {
    throw new Error(`port ${host}:${port} is already in use`);
  }

  await mkdir(dirname(logPath), { recursive: true });
  const log = openSync(logPath, "w");
  let serverChild;
  let foregroundChild;
  let signalHandlers;
  let resolveSignal;
  const signal = new Promise((resolve) => {
    resolveSignal = resolve;
  });
  const onSignal = (name) => resolveSignal({ kind: "signal", name });

  const sigintHandler = () => onSignal("SIGINT");
  const sigtermHandler = () => onSignal("SIGTERM");
  process.once("SIGINT", sigintHandler);
  process.once("SIGTERM", sigtermHandler);
  signalHandlers = { sigintHandler, sigtermHandler };

  try {
    serverChild = spawnCommand(server, ["ignore", log, log]);
    const readiness = await waitUntilReady({
      child: serverChild,
      server,
      host,
      port,
      logPath,
      signal,
    });
    if (readiness?.kind === "signal")
      return readiness.name === "SIGINT" ? 130 : 143;

    foregroundChild = spawnCommand(foreground, "inherit");
    const result = await Promise.race([waitForExit(foregroundChild), signal]);
    if (result?.kind === "signal") return result.name === "SIGINT" ? 130 : 143;
    if (result.error) throw result.error;
    return result.code ?? 1;
  } catch (error) {
    if (error?.message?.includes("already in use")) throw error;
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; command: ${commandText(foreground)}; log: ${logPath}`,
    );
  } finally {
    if (signalHandlers) {
      process.removeListener("SIGINT", signalHandlers.sigintHandler);
      process.removeListener("SIGTERM", signalHandlers.sigtermHandler);
    }
    await terminate(foregroundChild);
    await terminate(serverChild);
    closeSync(log);
  }
}
