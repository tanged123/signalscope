import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  dialog: {
    showOpenDialog: vi.fn(async () => ({
      canceled: false,
      filePaths: ["/tmp/a.csv"],
    })),
    showSaveDialog: vi.fn(async () => ({
      canceled: false,
      filePath: "/tmp/a.png",
    })),
  },
  ipcMain: {
    handle: vi.fn(
      (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
        mocks.handlers.set(channel, handler);
      },
    ),
  },
}));

vi.mock("electron", () => ({ dialog: mocks.dialog, ipcMain: mocks.ipcMain }));

import { registerDialogHandlers } from "../src/dialogs";
import { IPC } from "../src/types";

describe("fixed native dialogs", () => {
  const webContents = {};
  const window = { webContents };
  const event = { sender: webContents };

  beforeEach(() => {
    mocks.handlers.clear();
    vi.clearAllMocks();
    registerDialogHandlers(() => window as never);
  });

  it("builds source filters from validated provider formats", async () => {
    const result = await mocks.handlers.get(IPC.pickSources)!(event, [
      { id: "csv", label: "CSV", extensions: [".csv", "log"] },
    ]);
    expect(result).toEqual(["/tmp/a.csv"]);
    expect(mocks.dialog.showOpenDialog).toHaveBeenCalledWith(window, {
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "CSV", extensions: ["csv", "log"] }],
    });
  });

  it("rejects malformed renderer arguments", async () => {
    await expect(
      mocks.handlers.get(IPC.pickSources)!(event, [{ label: "bad" }]),
    ).rejects.toThrow(/formats/);
    await expect(
      mocks.handlers.get(IPC.pickExportFile)!(event, "", "png"),
    ).rejects.toThrow(/file name/);
  });
});
