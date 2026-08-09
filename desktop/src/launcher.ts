import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function desktopApplicationRoot(importMetaUrl: string): string {
  return resolve(dirname(fileURLToPath(importMetaUrl)), "..");
}

export function normalizeElectronArguments(
  arguments_: readonly string[],
): readonly string[] {
  return arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
}
