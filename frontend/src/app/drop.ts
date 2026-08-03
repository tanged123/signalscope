import type { IngestPort } from "./data-plane";

/**
 * Workspace files by extension. A dropped folder named `runs.json` would
 * misclassify — the frontend cannot stat — and then fail loudly in the
 * session loader, which is the accepted behavior for that edge.
 */
const WORKSPACE_EXTENSIONS = new Set(["signalscope", "json"]);

export type DropPlan =
  | { kind: "workspace"; path: string }
  | { kind: "data"; paths: string[] }
  | { kind: "rejected"; message: string };

export interface DropExpansion {
  files: string[];
  failures: string[];
}

export function classifyDrop(paths: string[]): DropPlan {
  const workspace = paths.filter((path) =>
    WORKSPACE_EXTENSIONS.has(extensionOf(path)),
  );
  if (workspace.length === 0) return { kind: "data", paths };
  const only = workspace[0];
  if (workspace.length === 1 && paths.length === 1 && only !== undefined) {
    return { kind: "workspace", path: only };
  }
  return {
    kind: "rejected",
    message: "drop either one workspace file or data files, not both",
  };
}

export async function expandDropPaths(
  port: IngestPort,
  paths: string[],
): Promise<DropExpansion> {
  const merged = new Set<string>();
  const failures: string[] = [];
  for (const path of paths) {
    try {
      for (const file of (await port.scanSources(path, true)).files) {
        merged.add(file);
      }
    } catch {
      failures.push(path);
    }
  }
  return { files: [...merged].sort(), failures };
}

export async function unsupportedDropMessage(
  port: IngestPort,
): Promise<string> {
  const formats = await port.listFormats();
  const extensions = formats.flatMap((format) =>
    format.extensions.map((extension) => `.${extension}`),
  );
  return `no supported files in the drop — supported: ${extensions.join(", ")}`;
}

function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}
