import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScopeDesktopBridge } from "./desktop-bridge";
import { seal } from "./envelope";
import { NativePlane } from "./native-plane";

const token = "A".repeat(43);

function bridge(): ScopeDesktopBridge {
  return {
    connect: vi.fn(() =>
      Promise.resolve({
        transportVersion: 1 as const,
        baseUrl: "http://127.0.0.1:43817",
        token,
        protocolVersion: 22,
      }),
    ),
    pickSources: vi.fn(() => Promise.resolve(["/tmp/run.csv"])),
    pickSourceFolder: vi.fn(() => Promise.resolve(null)),
    pickSession: vi.fn(() => Promise.resolve(null)),
    pickExportFile: vi.fn(() => Promise.resolve("/tmp/plot.png")),
    pickDirectory: vi.fn(() => Promise.resolve("/tmp")),
    onDragDrop: vi.fn(() => () => undefined),
    gpuInfo: vi.fn(() =>
      Promise.resolve({
        electron: "43",
        chromium: "150",
        os: "linux",
        featureStatus: {},
        gpu: {},
        softwareRendering: false,
        gpuMode: "hardware" as const,
      }),
    ),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("NativePlane", () => {
  it("maps catalog and ingest calls to authenticated protocol routes", async () => {
    const routes: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: URL | RequestInfo) => {
        const url =
          input instanceof URL
            ? input.href
            : input instanceof Request
              ? input.url
              : input;
        const path = new URL(url).pathname;
        routes.push(path);
        const payload = path.endsWith("/formats")
          ? [{ id: "csv", label: "CSV", extensions: ["csv"] }]
          : path.endsWith("/start")
            ? { job_id: "7" }
            : [];
        return Promise.resolve(
          new Response(JSON.stringify(seal(payload)), { status: 200 }),
        );
      }),
    );
    const desktop = bridge();
    const plane = await NativePlane.create(desktop);
    expect(await plane.ingest.pickSources()).toEqual(["/tmp/run.csv"]);
    expect(await plane.ingest.startBatch(["/tmp/run.csv"])).toBe("7");
    expect(routes).toEqual(["/v1/catalog/formats", "/v1/ingest/start"]);
  });

  it("uses the raw file route for export bytes", async () => {
    const desktop = bridge();
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: URL | RequestInfo, init?: RequestInit) => {
        expect(init?.headers).toBeDefined();
        return Promise.resolve(
          new Response(JSON.stringify(seal("/tmp/plot.png")), {
            status: 200,
          }),
        );
      }),
    );
    const plane = await NativePlane.create(desktop);
    await expect(
      plane.exporter.saveFile("plot.png", "png", new Uint8Array([1])),
    ).resolves.toBe("/tmp/plot.png");
  });
});
