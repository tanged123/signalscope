import type { SessionPort } from "./data-plane";

/**
 * Saves to the current workspace path unless Save As, or an unnamed
 * workspace, requires the user to choose one.
 */
export async function persistWorkspace(
  port: SessionPort,
  sessionJson: string,
  currentPath: string | null,
  saveAs: boolean,
): Promise<string | null> {
  const target =
    saveAs || currentPath === null ? await port.pick("save") : currentPath;
  if (target === null) return null;
  return port.save(sessionJson, target);
}
