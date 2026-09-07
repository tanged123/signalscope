import { BrowserWindow, shell } from "electron";
import { join } from "node:path";

const projectLinks = new Set([
  "https://github.com/tanged123/signalscope#readme",
  "https://github.com/tanged123/signalscope/issues",
]);

export function createWindow(launchUrl: string): BrowserWindow {
  const origin = new URL(launchUrl).origin;
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#151920", symbolColor: "#e6e8ec", height: 30 },
    backgroundColor: "#151920",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });
  window.removeMenu();
  window.webContents.ipc.on("titlebar-theme", (event, colors: unknown) => {
    const frame = event.senderFrame;
    if (
      frame === null ||
      frame !== window.webContents.mainFrame ||
      new URL(frame.url).origin !== origin ||
      typeof colors !== "object" ||
      colors === null
    )
      return;
    const { color, symbolColor } = colors as {
      color?: unknown;
      symbolColor?: unknown;
    };
    if (
      typeof color !== "string" ||
      typeof symbolColor !== "string" ||
      !/^#[0-9a-f]{6}$/i.test(color) ||
      !/^#[0-9a-f]{6}$/i.test(symbolColor)
    )
      return;
    window.setBackgroundColor(color);
    if (process.platform !== "darwin") {
      window.setTitleBarOverlay({ color, symbolColor });
    }
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== origin) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (projectLinks.has(url)) {
      void shell.openExternal(url).catch((error: unknown) => {
        console.error("Could not open the project link", error);
      });
    }
    return { action: "deny" };
  });
  window.webContents.session.on("will-download", (event) => {
    event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  window.once("ready-to-show", () => window.show());
  void window.loadURL(launchUrl);
  return window;
}
