import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { supervise } from "./process-supervisor.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arguments_ = process.argv.slice(2);
const softwareGpu = arguments_.includes("--software-gpu");
const separator = arguments_.indexOf("--");
const electronArguments =
  separator === -1
    ? arguments_.filter((argument) => argument !== "--software-gpu")
    : arguments_.slice(separator + 1);
const environment = {
  ...process.env,
  NODE_ENV: "development",
  SIGNALSCOPE_HOST_BIN: resolve(root, "target/debug/signalscope-host"),
};
if (softwareGpu) environment.SIGNALSCOPE_GPU_MODE = "software";
else delete environment.SIGNALSCOPE_GPU_MODE;

try {
  const code = await supervise({
    server: {
      command: "pnpm",
      args: ["--filter", "@signalscope/frontend", "dev"],
      cwd: root,
      env: environment,
    },
    foreground: {
      command: "pnpm",
      args: [
        "--filter",
        "@signalscope/desktop",
        "start",
        "--",
        ...electronArguments,
      ],
      cwd: root,
      env: environment,
    },
    host: "127.0.0.1",
    port: 4173,
    logPath: resolve(root, "build/vite.log"),
  });
  process.exitCode = code;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
