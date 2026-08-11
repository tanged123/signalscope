import { readFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { BrowserWindow, protocol } from "electron";

export interface WindowConfig {
  readonly entryUrl: string;
  readonly preloadPath: string;
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
};

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self'; connect-src 'self' http://127.0.0.1:*; " +
  "worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

export function registerAppProtocol(frontendRoot: string): void {
  const root = resolve(frontendRoot);
  protocol.handle("app", async (request) => {
    const url = new URL(request.url);
    let decoded: string;
    try {
      decoded = decodeURIComponent(url.pathname);
    } catch {
      return new Response("Not found", { status: 404 });
    }
    if (decoded.includes("\0"))
      return new Response("Not found", { status: 404 });
    const relativePath = decoded.replace(/^\/+/, "") || "index.html";
    const candidate = resolve(root, relativePath);
    const outside = relative(root, candidate);
    if (
      outside === ".." ||
      outside.startsWith(`..${sep}`) ||
      isAbsolute(outside)
    ) {
      return new Response("Not found", { status: 404 });
    }
    try {
      const body = await readFile(candidate);
      return new Response(body, {
        headers: {
          "Content-Security-Policy": CSP,
          "Content-Type":
            MIME_TYPES[extname(candidate).toLowerCase()] ??
            "application/octet-stream",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

function originOf(url: string): string {
  const parsed = new URL(url);
  return parsed.protocol === "app:"
    ? `${parsed.protocol}//${parsed.host}`
    : parsed.origin;
}

function allowedOrigin(config: WindowConfig): string {
  const parsed = new URL(config.entryUrl);
  const origin = originOf(config.entryUrl);
  if (origin !== "app://signalscope" && origin !== "http://127.0.0.1:4173") {
    throw new Error(`unsupported Electron entry origin: ${parsed.origin}`);
  }
  return origin;
}

export function createWindow(config: WindowConfig): BrowserWindow {
  const origin = allowedOrigin(config);
  const window = new BrowserWindow({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      preload: config.preloadPath,
    },
    show: false,
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (originOf(url) !== origin) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.session.on("will-download", (event) => {
    event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => {
      callback(false);
    },
  );
  window.webContents.on("did-finish-load", () => window.show());
  void window.loadURL(config.entryUrl);
  return window;
}

export function appProtocolPrivileges(): Electron.CustomScheme {
  return {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  };
}
