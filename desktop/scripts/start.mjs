import { access, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import {
  desktopApplicationRoot,
  normalizeElectronArguments,
} from "../dist/launcher.js";

const override = process.env.SIGNALSCOPE_ELECTRON_BIN;
const electron = override ? null : (await import("electron")).default;
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

const desktopRoot = desktopApplicationRoot(import.meta.url);
const child = spawn(
  executable,
  [desktopRoot, ...normalizeElectronArguments(process.argv.slice(2))],
  {
    cwd: desktopRoot,
    stdio: "inherit",
    env: process.env,
  },
);
process.exitCode = await new Promise((resolveExit, rejectExit) => {
  child.once("error", rejectExit);
  child.once("exit", (code, signal) => {
    resolveExit(code ?? (signal === null ? 1 : 1));
  });
});
