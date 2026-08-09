import {
  dialog,
  ipcMain,
  type BrowserWindow,
  type IpcMainInvokeEvent,
} from "electron";
import type { ExportDialogKind, FormatDescriptor } from "./types";
import { IPC } from "./types";

function assertSender(
  event: IpcMainInvokeEvent,
  getWindow: () => BrowserWindow | null,
): void {
  if (event.sender !== getWindow()?.webContents)
    throw new Error("invalid dialog caller");
}

function filters(formats: readonly FormatDescriptor[]): Electron.FileFilter[] {
  return formats
    .filter(
      (format) =>
        typeof format.label === "string" &&
        format.label.length > 0 &&
        Array.isArray(format.extensions),
    )
    .map((format) => ({
      name: format.label,
      extensions: format.extensions
        .filter((extension) => typeof extension === "string")
        .map((extension) => extension.replace(/^\./, ""))
        .filter((extension) => extension.length > 0),
    }))
    .filter((format) => format.extensions.length > 0);
}

function validateFormats(value: unknown): FormatDescriptor[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (format) =>
        format !== null &&
        typeof format === "object" &&
        typeof format.id === "string" &&
        typeof format.label === "string" &&
        Array.isArray(format.extensions) &&
        format.extensions.every(
          (extension: unknown) => typeof extension === "string",
        ),
    )
  ) {
    throw new Error("invalid source formats");
  }
  return value as FormatDescriptor[];
}

function exportExtension(kind: ExportDialogKind): string {
  return kind;
}

function validName(name: unknown): asserts name is string {
  if (typeof name !== "string" || name.length === 0 || name.includes("\0")) {
    throw new Error("invalid export file name");
  }
}

export function registerDialogHandlers(
  getWindow: () => BrowserWindow | null,
): void {
  ipcMain.handle(IPC.pickSources, async (event, formats: unknown) => {
    assertSender(event, getWindow);
    const validatedFormats = validateFormats(formats);
    const result = await dialog.showOpenDialog(getWindow()!, {
      properties: ["openFile", "multiSelections"],
      filters: filters(validatedFormats),
    });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle(IPC.pickSourceFolder, async (event) => {
    assertSender(event, getWindow);
    const result = await dialog.showOpenDialog(getWindow()!, {
      properties: ["openDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle(IPC.pickSession, async (event, mode: unknown) => {
    assertSender(event, getWindow);
    if (mode !== "open" && mode !== "save")
      throw new Error("invalid session dialog mode");
    const filters = [
      { name: "SignalScope workspace", extensions: ["signalscope"] },
    ];
    if (mode === "open") {
      const result = await dialog.showOpenDialog(getWindow()!, {
        filters,
        properties: ["openFile"],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    }
    const result = await dialog.showSaveDialog(getWindow()!, {
      defaultPath: "workspace.signalscope",
      filters,
    });
    return result.canceled ? null : (result.filePath ?? null);
  });
  ipcMain.handle(
    IPC.pickExportFile,
    async (event, name: unknown, kind: unknown) => {
      assertSender(event, getWindow);
      validName(name);
      if (kind !== "png" && kind !== "csv" && kind !== "html") {
        throw new Error("invalid export kind");
      }
      const extension = exportExtension(kind);
      const result = await dialog.showSaveDialog(getWindow()!, {
        defaultPath: name.endsWith(`.${extension}`)
          ? name
          : `${name}.${extension}`,
        filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
      });
      return result.canceled ? null : (result.filePath ?? null);
    },
  );
  ipcMain.handle(IPC.pickDirectory, async (event, kind: unknown) => {
    assertSender(event, getWindow);
    if (kind !== "export" && kind !== "recipe")
      throw new Error("invalid directory kind");
    const result = await dialog.showOpenDialog(getWindow()!, {
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
}
