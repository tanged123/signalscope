import { BrowserWindow, shell } from "electron";

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
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
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
