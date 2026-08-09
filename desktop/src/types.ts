export interface NativeConnection {
  readonly transportVersion: 1;
  readonly baseUrl: string;
  readonly token: string;
  readonly protocolVersion: number;
}

export interface BackendPaths {
  readonly executable: string;
  readonly configDir: string;
  readonly cacheDir: string;
  readonly resourceDir: string;
}

export interface FormatDescriptor {
  readonly id: string;
  readonly label: string;
  readonly extensions: readonly string[];
}

export type SessionDialogMode = "open" | "save";
export type ExportFileKind = "png" | "csv";
export type ExportDialogKind = ExportFileKind | "html";

export interface DragDropForward {
  readonly kind: "enter" | "drop" | "leave";
  readonly paths: readonly string[];
}

export interface DesktopGpuInfo {
  readonly electron: string;
  readonly chromium: string;
  readonly os: string;
  readonly featureStatus: Readonly<Record<string, string>>;
  readonly adapter: DesktopGpuAdapter;
  readonly gpu: Readonly<Record<string, unknown>>;
  readonly softwareRendering: boolean;
  readonly webGpuStatus: string;
  readonly fallbackReason: string | null;
  readonly gpuMode: "hardware" | "software";
}

export interface DesktopGpuAdapter {
  readonly vendor: string;
  readonly device: string;
  readonly description: string;
}

export interface ScopeDesktopBridge {
  connect(): Promise<NativeConnection>;
  pickSources(formats: readonly FormatDescriptor[]): Promise<string[]>;
  pickSourceFolder(): Promise<string | null>;
  pickSession(mode: SessionDialogMode): Promise<string | null>;
  pickExportFile(name: string, kind: ExportDialogKind): Promise<string | null>;
  pickDirectory(kind: "export" | "recipe"): Promise<string | null>;
  onDragDrop(handler: (event: DragDropForward) => void): () => void;
  gpuInfo(): Promise<DesktopGpuInfo>;
}

export const IPC = Object.freeze({
  connect: "scope:connect",
  pickSources: "scope:pick-sources",
  pickSourceFolder: "scope:pick-source-folder",
  pickSession: "scope:pick-session",
  pickExportFile: "scope:pick-export-file",
  pickDirectory: "scope:pick-directory",
  gpuInfo: "scope:gpu-info",
  dragDrop: "scope:drag-drop",
});
