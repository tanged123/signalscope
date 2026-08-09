import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const webContents = {
    on: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    session: {
      on: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
    },
    isLoading: vi.fn(() => false),
  };
  const window = {
    webContents,
    loadURL: vi.fn(),
    show: vi.fn(),
  };
  return {
    webContents,
    window,
    BrowserWindow: vi.fn(function BrowserWindow() {
      return window;
    }),
    protocol: { handle: vi.fn() },
  };
});

vi.mock("electron", () => ({
  BrowserWindow: mocks.BrowserWindow,
  protocol: mocks.protocol,
}));

import { appProtocolPrivileges, createWindow } from "../src/window";

describe("secure Electron window", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the fixed sandboxed BrowserWindow policy", () => {
    createWindow({
      entryUrl: "app://signalscope/index.html",
      preloadPath: "/tmp/preload.js",
    });
    expect(mocks.BrowserWindow).toHaveBeenCalledWith({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        preload: "/tmp/preload.js",
      },
      show: false,
    });
    expect(mocks.window.loadURL).toHaveBeenCalledWith(
      "app://signalscope/index.html",
    );
    expect(mocks.webContents.setWindowOpenHandler).toHaveBeenCalledWith(
      expect.any(Function),
    );
    expect(
      mocks.webContents.session.setPermissionRequestHandler,
    ).toHaveBeenCalledWith(expect.any(Function));
  });

  it.each([
    ["development", "http://127.0.0.1:4173/"],
    ["development bench", "http://127.0.0.1:4173/?signalscope-bench=1"],
    ["production", "app://signalscope/index.html"],
    ["production bench", "app://signalscope/index.html?signalscope-bench=1"],
  ])("loads only the exact %s origin", (_name, entryUrl) => {
    createWindow({
      entryUrl,
      preloadPath: "/tmp/preload.js",
    });
    expect(mocks.window.loadURL).toHaveBeenCalledWith(entryUrl);
    const navigation = mocks.webContents.on.mock.calls.find(
      ([name]) => name === "will-navigate",
    )?.[1] as
      | ((event: { preventDefault(): void }, url: string) => void)
      | undefined;
    expect(navigation).toBeDefined();
    const event = { preventDefault: vi.fn() };
    navigation!(event, "https://example.com");
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("declares the privileged app scheme", () => {
    expect(appProtocolPrivileges()).toEqual({
      scheme: "app",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    });
  });
});
