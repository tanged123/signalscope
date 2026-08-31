import { join } from "node:path";

export interface DesktopResources {
  readonly executable: string;
  readonly frontend: string;
}

export function resolveDesktopResources(
  resourceRoot: string,
  platform: NodeJS.Platform,
): DesktopResources {
  return {
    executable: join(
      resourceRoot,
      "bin",
      platform === "win32" ? "scope-server.exe" : "scope-server",
    ),
    frontend: join(resourceRoot, "frontend"),
  };
}
