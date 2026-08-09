import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { supervise } from "./process-supervisor.mjs";

const root = mkdtempSync(join(tmpdir(), "signalscope-supervisor-"));
const fixture = join(root, "child.mjs");
writeFileSync(
  fixture,
  `import net from "node:net";
import { spawn } from "node:child_process";
const [mode, value, pidFile] = process.argv.slice(2);
let server;
if (mode === "server") {
  server = net.createServer((socket) => socket.end());
  server.listen(Number(value), "127.0.0.1");
}
if (mode === "crash") setTimeout(() => process.exit(9), 20);
if (pidFile) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const fs = await import("node:fs");
  fs.writeFileSync(pidFile, String(child.pid));
}
if (mode === "exit" && Number(value) >= 0) setTimeout(() => process.exit(Number(value)), 40);
process.on("SIGTERM", () => {
  server?.close(() => process.exit(0));
  if (!server) process.exit(0);
});
process.on("SIGINT", () => process.exit(130));
setInterval(() => {}, 1000);
`,
);
chmodSync(fixture, 0o644);

const command = (mode, value, pidFile) => ({
  command: process.execPath,
  args: [fixture, mode, String(value ?? 0), ...(pidFile ? [pidFile] : [])],
});
const listener = net.createServer();
await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
const logPath = join(root, "vite.log");

async function waitForFile(path) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const fs = await import("node:fs/promises");
      return Number(await fs.readFile(path, "utf8"));
    } catch {
      await delay(10);
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let spawned = false;
await assert.rejects(
  supervise({
    server: { ...command("server", port), onSpawn: () => (spawned = true) },
    foreground: command("exit", 0),
    host: "127.0.0.1",
    port,
    logPath,
  }),
  /already in use/,
);
assert.equal(spawned, false);
await new Promise((resolve) => listener.close(resolve));

assert.equal(
  await supervise({
    server: command("server", port),
    foreground: command("exit", 0),
    host: "127.0.0.1",
    port,
    logPath,
  }),
  0,
);
const portClosed = await new Promise((resolve) => {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  socket.once("connect", () => {
    socket.destroy();
    resolve(false);
  });
  socket.once("error", () => resolve(true));
});
assert.equal(portClosed, true);

assert.equal(
  await supervise({
    server: command("server", port),
    foreground: command("exit", 7),
    host: "127.0.0.1",
    port,
    logPath,
  }),
  7,
);

await assert.rejects(
  supervise({
    server: command("crash"),
    foreground: command("exit", 0),
    host: "127.0.0.1",
    port,
    logPath,
  }),
  new RegExp(`server.*${logPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
);

const serverPidFile = join(root, "server.pid");
const foregroundPidFile = join(root, "foreground.pid");
const supervisorFile = join(root, "supervisor.mjs");
writeFileSync(
  supervisorFile,
  `import { supervise } from ${JSON.stringify(new URL("./process-supervisor.mjs", import.meta.url).href)};
const fixture = ${JSON.stringify(fixture)};
const command = (mode, value, pidFile) => ({ command: process.execPath, args: [fixture, mode, String(value ?? 0), ...(pidFile ? [pidFile] : [])] });
const code = await supervise({ server: command("server", ${port}, ${JSON.stringify(serverPidFile)}), foreground: command("exit", -1, ${JSON.stringify(foregroundPidFile)}), host: "127.0.0.1", port: ${port}, logPath: ${JSON.stringify(logPath)} });
process.exit(code);
`,
);
const signalProbe = spawn(process.execPath, [supervisorFile], {
  stdio: "ignore",
});
const serverPid = await waitForFile(serverPidFile);
const foregroundPid = await waitForFile(foregroundPidFile);
signalProbe.kill("SIGTERM");
const signalStatus = await new Promise((resolve) =>
  signalProbe.once("exit", (code, signal) => resolve({ code, signal })),
);
assert.deepEqual(signalStatus, { code: 143, signal: null });
await delay(50);
assert.equal(alive(serverPid), false);
assert.equal(alive(foregroundPid), false);

console.log("Process supervisor tests passed.");
