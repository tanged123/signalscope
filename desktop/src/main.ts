import { app, BrowserWindow, dialog } from "electron";
import { BackendProcess } from "./backend";
import { resolveDesktopResources } from "./resources";
import { createWindow } from "./window";

app.commandLine.appendSwitch("disable-features", "AutofillServerCommunication");
app.enableSandbox();

let backend: BackendProcess | null = null;
let mainWindow: BrowserWindow | null = null;
let quitting = false;
let stopping: Promise<void> | null = null;

function openWindow(): void {
  if (backend === null) return;
  mainWindow = createWindow(backend.launchUrl);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    const gpu = app.getGPUFeatureStatus();
    const webgpu = (gpu as unknown as Record<string, string>).webgpu;
    dialog.showErrorBox(
      "SignalScope renderer stopped",
      `${details.reason}\nWebGPU: ${webgpu ?? "unknown"}`,
    );
    app.quit();
  });
}

async function start(): Promise<void> {
  const resourceRoot =
    process.env.SIGNALSCOPE_RESOURCE_DIR ?? process.resourcesPath;
  const resources = resolveDesktopResources(resourceRoot, process.platform);
  backend = await BackendProcess.start({
    ...resources,
    data: app.getPath("userData"),
  });
  void backend.exited().then(({ code, signal }) => {
    if (quitting) return;
    dialog.showErrorBox(
      "SignalScope server stopped",
      `scope-server exited unexpectedly (${code ?? signal ?? "unknown"}).`,
    );
    app.quit();
  });
  if (process.env.SIGNALSCOPE_GPU_DIAGNOSTICS === "1") {
    const diagnostics = {
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      featureStatus: app.getGPUFeatureStatus(),
      gpu: await app.getGPUInfo("basic"),
    };
    console.error(JSON.stringify(diagnostics));
  }
  openWindow();
}

function stopBackend(): Promise<void> {
  quitting = true;
  stopping ??= backend?.stop() ?? Promise.resolve();
  return stopping;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow === null) openWindow();
    else {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.on("activate", () => {
    if (mainWindow === null) openWindow();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", (event) => {
    if (stopping === null && backend !== null) {
      event.preventDefault();
      void stopBackend().then(() => app.quit());
    }
  });
  void app
    .whenReady()
    .then(start)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      dialog.showErrorBox("SignalScope could not start", message);
      app.quit();
    });
}
