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
    BrowserWindow: vi.fn(function BrowserWindow() {
      return window;
    }),
  };
});

vi.mock("electron", () => ({ BrowserWindow: mocks.BrowserWindow }));

import { createWindow } from "../src/window";

describe("secure Electron window", () => {
  beforeEach(() => vi.clearAllMocks());

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
