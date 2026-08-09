import { access, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import electron from "electron";

const override = process.env.SIGNALSCOPE_ELECTRON_BIN;
const executable = override ?? electron;
if (!isAbsolute(executable)) {
  throw new Error("SIGNALSCOPE_ELECTRON_BIN must be an absolute path");
}
try {
  await access(executable);
  if (!(await stat(executable)).isFile()) throw new Error("not a file");
} catch {
  throw new Error(`Electron executable is missing: ${executable}`);
}

const child = spawn(executable, [".", ...process.argv.slice(2)], {
  cwd: new URL("../../", import.meta.url),
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal === null ? 1 : 0);
});
