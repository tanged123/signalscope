import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, net, protocol } from "electron";
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
  if (process.platform === "win32") {
    // Windows software WebGPU is Dawn's D3D WARP fallback. Forcing the
    // SwiftShader switches below steers the GPU process off the D3D path
    // and leaves no adapter at all (observed on GPU-less runners).
    app.commandLine.appendSwitch("ignore-gpu-blocklist");
  } else {
    app.commandLine.appendSwitch("enable-unsafe-swiftshader");
    app.commandLine.appendSwitch("enable-features", "Vulkan");
    app.commandLine.appendSwitch("use-angle", "swiftshader");
    app.commandLine.appendSwitch("use-webgpu-adapter", "swiftshader");
  }
}
app.commandLine.appendSwitch("disable-features", "AutofillServerCommunication");
app.enableSandbox();
// Electron requires privileged schemes to be registered before ready.
protocol.registerSchemesAsPrivileged([appProtocolPrivileges()]);

let mainWindow: BrowserWindow | null = null;
let backend: BackendProcess | null = null;
let stopping: Promise<void> | null = null;
const queuedPaths = new Set<string>();
const FILE_WRITE_CHUNK_BYTES = 64 * 1024;

interface PendingFileWrite {
  readonly request: Electron.ClientRequest;
  readonly response: Promise<NativeFileResponse>;
  failure: Error | null;
  writeWaiter: {
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
  } | null;
}

interface NativeFileResponse {
  readonly status: number;
  readonly body: string;
}

const pendingFileWrites = new Map<string, PendingFileWrite>();
let nextFileWriteId = 0;

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
  ipcMain.handle(IPC.beginFileWrite, (event) => {
    assertFileWriteCaller(event);
    return beginFileWrite();
  });
  ipcMain.handle(
    IPC.writeFileChunk,
    async (event, id: unknown, chunk: unknown) => {
      assertFileWriteCaller(event);
      await writeFileChunk(id, chunk);
    },
  );
  ipcMain.handle(IPC.finishFileWrite, async (event, id: unknown) => {
    assertFileWriteCaller(event);
    return finishFileWrite(id);
  });
  ipcMain.handle(IPC.abortFileWrite, (event, id: unknown) => {
    assertFileWriteCaller(event);
    abortFileWrite(id);
  });
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

function assertFileWriteCaller(event: Electron.IpcMainInvokeEvent): void {
  if (event.sender !== mainWindow?.webContents)
    throw new Error("invalid file write caller");
}

function fileWriteId(): string {
  nextFileWriteId += 1;
  return String(nextFileWriteId);
}

function beginFileWrite(): string {
  if (backend === null) throw new Error("native host is not running");
  // Electron 43 rejects renderer ReadableStream uploads to the loopback HTTP/1
  // server, so keep the request streamed through Chromium's main-process API.
  const connection = backend.connection();
  const request = net.request({
    method: "POST",
    url: `${connection.baseUrl}/v1/export/file`,
  });
  request.setHeader("Authorization", `Bearer ${connection.token}`);
  request.setHeader("Content-Type", "application/octet-stream");
  request.chunkedEncoding = true;

  let resolveResponse!: (response: NativeFileResponse) => void;
  let rejectResponse!: (error: Error) => void;
  const response = new Promise<NativeFileResponse>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const pending: PendingFileWrite = {
    failure: null,
    request,
    response,
    writeWaiter: null,
  };
  request.on("response", (incoming) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    incoming.on("end", () => {
      resolveResponse({
        body: Buffer.concat(chunks).toString("utf8"),
        status: incoming.statusCode,
      });
    });
    incoming.on("error", (error) => rejectResponse(error));
  });
  request.on("error", (error) => {
    pending.failure = error;
    pending.writeWaiter?.reject(error);
    pending.writeWaiter = null;
    rejectResponse(error);
  });
  const id = fileWriteId();
  pendingFileWrites.set(id, pending);
  return id;
}

function pendingFileWrite(id: unknown): PendingFileWrite {
  if (typeof id !== "string") throw new Error("invalid file write id");
  const pending = pendingFileWrites.get(id);
  if (pending === undefined) throw new Error("unknown file write id");
  return pending;
}

async function writeFileChunk(id: unknown, chunk: unknown): Promise<void> {
  const pending = pendingFileWrite(id);
  if (
    !(chunk instanceof Uint8Array) ||
    chunk.byteLength > FILE_WRITE_CHUNK_BYTES
  )
    throw new Error("invalid file write chunk");
  if (pending.failure !== null) throw pending.failure;
  const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  await new Promise<void>((resolve, reject) => {
    pending.writeWaiter = { reject, resolve };
    try {
      pending.request.write(buffer, undefined, () => {
        pending.writeWaiter = null;
        resolve();
      });
    } catch (error) {
      pending.writeWaiter = null;
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function finishFileWrite(id: unknown): Promise<NativeFileResponse> {
  const pending = pendingFileWrite(id);
  try {
    pending.request.end();
    return await pending.response;
  } finally {
    pendingFileWrites.delete(String(id));
  }
}

function abortFileWrite(id: unknown): void {
  const pending = pendingFileWrite(id);
  pendingFileWrites.delete(String(id));
  pending.response.catch(() => undefined);
  pending.request.abort();
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
