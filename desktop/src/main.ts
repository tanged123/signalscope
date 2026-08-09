import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, protocol } from "electron";
import { BackendProcess } from "./backend";
import { registerDialogHandlers } from "./dialogs";
import { IPC, type DesktopGpuInfo, type NativeConnection } from "./types";
import {
  appProtocolPrivileges,
  createWindow,
  registerAppProtocol,
} from "./window";

const isDevelopment = process.env.NODE_ENV === "development";
const gpuMode = process.env.SIGNALSCOPE_GPU_MODE;
if (gpuMode !== undefined && gpuMode !== "software") {
  throw new Error("SIGNALSCOPE_GPU_MODE must be software when set");
}
if (gpuMode === "software") {
  app.commandLine.appendSwitch("enable-unsafe-webgpu");
  app.commandLine.appendSwitch("enable-features", "Vulkan");
  app.commandLine.appendSwitch("use-angle", "swiftshader");
  app.commandLine.appendSwitch("use-webgpu-adapter", "swiftshader");
}
app.commandLine.appendSwitch("disable-features", "AutofillServerCommunication");
app.enableSandbox();
// Electron requires privileged schemes to be registered before ready.
protocol.registerSchemesAsPrivileged([appProtocolPrivileges()]);

let mainWindow: BrowserWindow | null = null;
let backend: BackendProcess | null = null;
let stopping: Promise<void> | null = null;
const queuedPaths = new Set<string>();

interface GpuDeviceInfo {
  readonly vendorId?: number;
  readonly deviceId?: number;
  readonly driverVersion?: string;
  readonly driverVendor?: string;
  readonly active?: boolean;
  readonly description?: string;
}

interface CompleteGpuInfo {
  readonly gpuDevice?: readonly GpuDeviceInfo[];
  readonly auxAttributes?: Readonly<Record<string, unknown>>;
}

function launchPaths(argv: readonly string[]): void {
  for (const path of argv) {
    if (path.length > 0 && !path.startsWith("--")) queuedPaths.add(path);
  }
  sendQueuedPaths();
}

function sendQueuedPaths(): void {
  if (
    mainWindow === null ||
    mainWindow.webContents.isLoading() ||
    queuedPaths.size === 0
  )
    return;
  const paths = [...queuedPaths];
  queuedPaths.clear();
  mainWindow.webContents.send(IPC.dragDrop, paths);
}

async function gpuInfo(): Promise<DesktopGpuInfo> {
  const status = app.getGPUFeatureStatus();
  const complete = (await app.getGPUInfo("complete")) as CompleteGpuInfo;
  const softwareRendering = Object.values(status).some((value) =>
    /software|swiftshader|llvmpipe|lavapipe|warp|disabled|unavailable/i.test(
      value,
    ),
  );
  return {
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    os: process.platform,
    featureStatus: { ...status },
    gpu: {
      devices: (complete.gpuDevice ?? []).map((device) => ({
        vendorId: device.vendorId,
        deviceId: device.deviceId,
        driverVersion: device.driverVersion,
        driverVendor: device.driverVendor,
        active: device.active,
        description: device.description,
      })),
      auxAttributes: complete.auxAttributes ?? {},
    },
    softwareRendering,
    gpuMode: gpuMode === "software" ? "software" : "hardware",
  };
}

async function start(): Promise<void> {
  const frontendRoot = isDevelopment
    ? join(__dirname, "../../frontend/dist")
    : join(process.resourcesPath, "frontend");
  const executable =
    process.env.SIGNALSCOPE_HOST_BIN ??
    join(
      process.resourcesPath,
      "bin",
      process.platform === "win32"
        ? "signalscope-host.exe"
        : "signalscope-host",
    );
  const configDir = app.getPath("userData");
  const cacheDir = join(app.getPath("userData"), "cache");
  const resourceDir = frontendRoot;
  backend = await BackendProcess.start(
    { executable, configDir, cacheDir, resourceDir },
    isDevelopment ? "http://127.0.0.1:4173" : null,
  );
  ipcMain.handle(IPC.connect, (): NativeConnection => backend!.connection());
  ipcMain.handle(IPC.gpuInfo, (): Promise<DesktopGpuInfo> => gpuInfo());
  registerDialogHandlers(() => mainWindow);
  registerAppProtocol(frontendRoot);
  mainWindow = createWindow({
    developmentUrl: isDevelopment ? "http://127.0.0.1:4173" : null,
    frontendRoot,
    preloadPath: join(__dirname, "preload.js"),
  });
  mainWindow.webContents.on("did-finish-load", sendQueuedPaths);
}

function stopBackend(): Promise<void> {
  stopping ??= backend?.stop() ?? Promise.resolve();
  return stopping;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => launchPaths(argv.slice(1)));
  app.on("open-file", (event, path) => {
    event.preventDefault();
    launchPaths([path]);
  });
  app.on("before-quit", (event) => {
    if (stopping === null && backend !== null) {
      event.preventDefault();
      void stopBackend().then(() => app.quit());
    }
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app
    .whenReady()
    .then(() => start())
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      void dialog.showErrorBox("SignalScope could not start", message);
      app.quit();
    });
  launchPaths(process.argv.slice(1));
}

export const parseGpuMode = (): "hardware" | "software" | undefined => gpuMode;
export { gpuInfo, launchPaths };
