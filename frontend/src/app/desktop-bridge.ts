import type {
  DragDropForward,
  ExportFileKind,
  FormatDescriptor,
  SessionDialogMode,
} from "../generated/protocol";

export type ExportDialogKind = ExportFileKind | "html";

export interface NativeConnection {
  readonly transportVersion: 1;
  readonly baseUrl: string;
  readonly token: string;
  readonly protocolVersion: number;
}

export interface DesktopGpuInfo {
  readonly electron: string;
  readonly chromium: string;
  readonly os: string;
  readonly featureStatus: Readonly<Record<string, string>>;
  readonly gpu: Readonly<Record<string, unknown>>;
  readonly softwareRendering: boolean;
  readonly gpuMode: "hardware" | "software";
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

declare global {
  interface Window {
    scopeDesktop?: ScopeDesktopBridge;
  }
}
