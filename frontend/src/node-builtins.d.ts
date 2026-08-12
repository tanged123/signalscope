declare module "node:fs" {
  export function existsSync(path: string | URL): boolean;
  export function mkdirSync(
    path: string | URL,
    options?: { recursive?: boolean },
  ): string | undefined;
  export function mkdtempSync(path: string): string;
  export function rmSync(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): void;
  export function readFileSync(path: URL): Uint8Array;
  export function readFileSync(path: URL, encoding: "utf8"): string;
  export function writeFileSync(path: string | URL, data: string): void;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}

declare module "node:child_process" {
  export interface ChildProcess {
    kill(signal?: string): boolean;
  }
  export function spawn(
    command: string,
    args?: readonly string[],
    options?: { cwd?: string; stdio?: "ignore" },
  ): ChildProcess;
}
