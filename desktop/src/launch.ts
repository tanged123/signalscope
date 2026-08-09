import { isAbsolute } from "node:path";

const OPEN_FLAGS = new Set(["--open", "--open-folder"]);

export function parseLaunchPaths(argv: readonly string[]): string[] {
  const paths: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (OPEN_FLAGS.has(argument)) {
      const flag = argument;
      const path = argv[++index];
      if (path === undefined || !isAbsolute(path)) {
        throw new Error(`${flag} requires an absolute path`);
      }
      paths.push(path);
      continue;
    }
    if (
      argument.startsWith("--open-folder=") ||
      argument.startsWith("--open=")
    ) {
      const separator = argument.indexOf("=");
      const flag = argument.slice(0, separator);
      const path = argument.slice(separator + 1);
      if (!isAbsolute(path)) {
        throw new Error(`${flag} requires an absolute path`);
      }
      paths.push(path);
      continue;
    }
    if (!argument.startsWith("--") && argument.length > 0) paths.push(argument);
  }
  return paths;
}
