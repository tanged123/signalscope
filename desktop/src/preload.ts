import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { DragDropForward, ScopeDesktopBridge } from "./types";

const IPC = Object.freeze({
  connect: "scope:connect",
  pickSources: "scope:pick-sources",
  pickSourceFolder: "scope:pick-source-folder",
  pickSession: "scope:pick-session",
  pickExportFile: "scope:pick-export-file",
  pickDirectory: "scope:pick-directory",
  gpuInfo: "scope:gpu-info",
  dragDrop: "scope:drag-drop",
});

const callbacks = new Set<(event: DragDropForward) => void>();
let listenersInstalled = false;
let ipcListenerInstalled = false;

function pathsFromDataTransfer(dataTransfer: DataTransfer | null): string[] {
  if (dataTransfer === null) return [];
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const file of Array.from(dataTransfer.files)) {
    const path = webUtils.getPathForFile(file);
    if (path.length > 0 && !seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

function notify(event: DragDropForward): void {
  for (const callback of callbacks) callback(event);
}

function installIpcListener(): void {
  if (ipcListenerInstalled) return;
  ipcListenerInstalled = true;
  ipcRenderer.on(IPC.dragDrop, (_event, paths: unknown) => {
    if (!Array.isArray(paths)) return;
    const valid = paths.filter(
      (path): path is string => typeof path === "string" && path.length > 0,
    );
    if (valid.length > 0) notify({ kind: "drop", paths: [...new Set(valid)] });
  });
}

function installDropListeners(): void {
  if (listenersInstalled) return;
  listenersInstalled = true;
  document.addEventListener("dragenter", (event) => {
    const paths = pathsFromDataTransfer(event.dataTransfer);
    if (paths.length > 0) notify({ kind: "enter", paths });
  });
  document.addEventListener("dragleave", (event) => {
    const paths = pathsFromDataTransfer(event.dataTransfer);
    if (paths.length > 0) notify({ kind: "leave", paths });
  });
  document.addEventListener("drop", (event) => {
    const paths = pathsFromDataTransfer(event.dataTransfer);
    if (paths.length > 0) notify({ kind: "drop", paths });
  });
}

const bridge: ScopeDesktopBridge = {
  connect: async () =>
    Object.freeze({ ...(await ipcRenderer.invoke(IPC.connect)) }),
  pickSources: (formats) => ipcRenderer.invoke(IPC.pickSources, formats),
  pickSourceFolder: () => ipcRenderer.invoke(IPC.pickSourceFolder),
  pickSession: (mode) => ipcRenderer.invoke(IPC.pickSession, mode),
  pickExportFile: (name, kind) =>
    ipcRenderer.invoke(IPC.pickExportFile, name, kind),
  pickDirectory: (kind) => ipcRenderer.invoke(IPC.pickDirectory, kind),
  onDragDrop: (handler) => {
    callbacks.add(handler);
    installDropListeners();
    installIpcListener();
    return () => {
      callbacks.delete(handler);
    };
  },
  gpuInfo: async () => Object.freeze(await ipcRenderer.invoke(IPC.gpuInfo)),
};

contextBridge.exposeInMainWorld("scopeDesktop", bridge);
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", installDropListeners, {
    once: true,
  });
} else {
  installDropListeners();
}
