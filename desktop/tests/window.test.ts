import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const webContents = {
    on: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    session: {
      on: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
    },
  };
  const window = {
    webContents,
    once: vi.fn(),
    loadURL: vi.fn(),
    show: vi.fn(),
  };
  return {
    webContents,
    window,
    openExternal: vi.fn().mockResolvedValue(undefined),
    BrowserWindow: vi.fn(function BrowserWindow() {
      return window;
    }),
  };
});

vi.mock("electron", () => ({
  BrowserWindow: mocks.BrowserWindow,
  shell: { openExternal: mocks.openExternal },
}));

import { createWindow } from "../src/window";

describe("secure Electron window", () => {
  beforeEach(() => vi.clearAllMocks());

  it("opens only the About project links in the external browser", () => {
    createWindow("http://127.0.0.1:43817/");
    const open = mocks.webContents.setWindowOpenHandler.mock
      .calls[0]?.[0] as (details: { url: string }) => { action: string };
    for (const url of [
      "https://github.com/tanged123/signalscope#readme",
      "https://github.com/tanged123/signalscope/issues",
    ]) {
      expect(open({ url })).toEqual({ action: "deny" });
      expect(mocks.openExternal).toHaveBeenLastCalledWith(url);
    }
    for (const url of [
      "https://example.com",
      "https://github.com/tanged123/signalscope/issues/../other",
      "https://github.com.evil.test/tanged123/signalscope/issues",
      "file:///tmp/example",
      "javascript:alert(1)",
    ])
      expect(open({ url })).toEqual({ action: "deny" });
    expect(mocks.openExternal).toHaveBeenCalledTimes(2);
  });

  it("loads only the authenticated loopback origin in a sandbox", () => {
    const url =
      "http://127.0.0.1:43817/?token=0123456789abcdef0123456789abcdef";
    createWindow(url);
    expect(mocks.BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        show: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          allowRunningInsecureContent: false,
          webviewTag: false,
        },
      }),
    );
    expect(mocks.window.loadURL).toHaveBeenCalledWith(url);
    const navigation = mocks.webContents.on.mock.calls.find(
      ([name]) => name === "will-navigate",
    )?.[1] as (event: { preventDefault(): void }, url: string) => void;
    const event = { preventDefault: vi.fn() };
    navigation(event, "https://example.com");
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });
});
