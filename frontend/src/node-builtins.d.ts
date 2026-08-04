declare module "node:fs" {
  export function existsSync(path: string | URL): boolean;
  export function mkdirSync(
    path: string | URL,
    options?: { recursive?: boolean },
  ): string | undefined;
  export function readFileSync(path: URL, encoding: "utf8"): string;
  export function writeFileSync(path: string | URL, data: string): void;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}
