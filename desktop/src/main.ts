import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, protocol } from "electron";
import { BackendProcess } from "./backend";
import { registerDialogHandlers } from "./dialogs";
import { parseLaunchPaths } from "./launch";
import {
  classifyElectronGpu,
  selectActiveGpuDevice,
  type GpuDeviceInfo,
} from "./gpu";
import { IPC, type DesktopGpuInfo, type NativeConnection } from "./types";
import {
  appProtocolPrivileges,
  createWindow,
  registerAppProtocol,
} from "./window";

const isDevelopment = process.env.NODE_ENV === "development";
const developmentOrigin = "http://127.0.0.1:4173";
const benchQuery =
  process.env.SIGNALSCOPE_BENCH === "1" ? "?signalscope-bench=1" : "";
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

interface CompleteGpuInfo {
  readonly gpuDevice?: readonly GpuDeviceInfo[];
  readonly auxAttributes?: Readonly<Record<string, unknown>>;
}

function deviceNumber(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `0x${value.toString(16)}`
    : "";
}

function launchPaths(argv: readonly string[]): void {
  const appArguments = argv[0] === app.getAppPath() ? argv.slice(1) : argv;
  for (const path of parseLaunchPaths(appArguments)) queuedPaths.add(path);
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
  const devices = complete.gpuDevice ?? [];
  const activeDevice = selectActiveGpuDevice(devices);
  const classification = classifyElectronGpu(
    status,
    activeDevice,
    gpuMode === "software",
  );
  return {
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    os: process.platform,
    featureStatus: { ...status },
    adapter: {
      vendor: activeDevice?.driverVendor ?? "",
      device: deviceNumber(activeDevice?.deviceId),
      description: activeDevice?.description ?? "",
    },
    gpu: {
      devices: devices.map((device) => ({
        vendorId: device.vendorId,
        deviceId: device.deviceId,
        driverVersion: device.driverVersion,
        driverVendor: device.driverVendor,
        active: device.active,
        description: device.description,
      })),
      auxAttributes: complete.auxAttributes ?? {},
    },
    softwareRendering: classification.softwareRendering,
    webGpuStatus: classification.webGpuStatus,
    fallbackReason: classification.fallbackReason,
    gpuMode: classification.softwareRendering ? "software" : "hardware",
  };
}

async function start(): Promise<void> {
  const resourceRoot =
    process.env.SIGNALSCOPE_RESOURCE_DIR ?? process.resourcesPath;
  const frontendRoot = isDevelopment
    ? join(__dirname, "../../frontend/dist")
    : join(resourceRoot, "frontend");
  const executable =
    process.env.SIGNALSCOPE_HOST_BIN ??
    join(
      resourceRoot,
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
    isDevelopment ? developmentOrigin : null,
  );
  ipcMain.on(IPC.rendererReady, sendQueuedPaths);
  ipcMain.handle(IPC.connect, (): NativeConnection => backend!.connection());
  ipcMain.handle(IPC.gpuInfo, (): Promise<DesktopGpuInfo> => gpuInfo());
  registerDialogHandlers(() => mainWindow);
  registerAppProtocol(frontendRoot);
  mainWindow = createWindow({
    entryUrl: isDevelopment
      ? `${developmentOrigin}/${benchQuery}`
      : `app://signalscope/index.html${benchQuery}`,
    preloadPath: join(__dirname, "preload.js"),
  });
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
