import { describe, expect, it } from "vitest";

import type { BatchStatus } from "../generated/protocol";
import type { IngestPort } from "./data-plane";
import { pickIngestPaths, runBatchIngest, waitForBatch } from "./ingest";

interface FakePort extends IngestPort {
  released: string[];
}

function fakePort(statuses: BatchStatus[]): FakePort {
  const queue = [...statuses];
  const released: string[] = [];
  return {
    released,
    pickSources: () => Promise.resolve([]),
    pickSourceFolder: () => Promise.resolve(null),
    scanSources: () =>
      Promise.resolve({ files: [], total_bytes: "0", format_counts: [] }),
    startBatch: () => Promise.resolve("1"),
    batchStatus: () => {
      const status = queue.shift();
      if (status === undefined) throw new Error("status queue exhausted");
      return Promise.resolve(status);
    },
    batchDetail: () => Promise.resolve({ entries: [], total: "0" }),
    cancelBatch: () => Promise.resolve(),
    releaseBatch: (jobId) => {
      released.push(jobId);
      return Promise.resolve();
    },
    listFormats: () => Promise.resolve([]),
    introspect: () => Promise.reject(new Error("not used in ingest tests")),
    saveRecipe: () => Promise.reject(new Error("not used in ingest tests")),
  };
}

describe("runBatchIngest", () => {
  it("resolves partial batches and surfaces failures", async () => {
    const port = fakePort([
      {
        state: "running",
        fraction: 0.5,
        total: "2",
        done: "1",
        failed: "0",
        current_paths: [],
        recent_failures: [],
      },
      {
        state: "partial",
        fraction: 1,
        total: "2",
        done: "1",
        failed: "1",
        current_paths: [],
        recent_failures: [
          { path: "/b.csv", error: "unsupported", recipe_required: false },
        ],
      },
    ]);
    const seen: string[] = [];
    const status = await runBatchIngest(
      port,
      ["/a.csv", "/b.csv"],
      (progress) => seen.push(progress.state),
      0,
    );

    expect(status.state).toBe("partial");
    expect(status.recent_failures[0]?.error).toBe("unsupported");
    expect(seen).toEqual(["running", "partial"]);
  });

  it("does not throw when every file fails", async () => {
    const port = fakePort([
      {
        state: "failed",
        fraction: 1,
        total: "1",
        done: "0",
        failed: "1",
        current_paths: [],
        recent_failures: [
          { path: "/a.csv", error: "boom", recipe_required: false },
        ],
      },
    ]);
    await expect(
      runBatchIngest(port, ["/a.csv"], () => undefined, 0),
    ).resolves.toMatchObject({ state: "failed" });
  });

  it("releases terminal jobs", async () => {
    const port = fakePort([
      {
        state: "done",
        fraction: 1,
        total: "1",
        done: "1",
        failed: "0",
        current_paths: [],
        recent_failures: [],
      },
    ]);
    await runBatchIngest(port, ["/a.csv"], () => undefined, 0);
    expect(port.released).toEqual(["1"]);
  });

  it("can wait without releasing before reconciliation", async () => {
    const port = fakePort([
      {
        state: "done",
        fraction: 1,
        total: "1",
        done: "1",
        failed: "0",
        current_paths: [],
        recent_failures: [],
      },
    ]);
    await waitForBatch(port, "1", () => undefined, 0);
    expect(port.released).toEqual([]);
  });
});

describe("pickIngestPaths", () => {
  it("returns selected files directly", async () => {
    const port = fakePort([]);
    port.pickSources = () => Promise.resolve(["/data/a.csv", "/data/b.mcap"]);

    await expect(pickIngestPaths(port, "files")).resolves.toEqual([
      "/data/a.csv",
      "/data/b.mcap",
    ]);
  });

  it("recursively resolves a selected folder to supported files", async () => {
    const port = fakePort([]);
    const scans: [string, boolean][] = [];
    port.pickSourceFolder = () => Promise.resolve("/data/runs");
    port.scanSources = (path, recursive) => {
      scans.push([path, recursive]);
      return Promise.resolve({
        files: ["/data/runs/a.csv", "/data/runs/sub/b.csv"],
        total_bytes: "2",
        format_counts: [],
      });
    };

    await expect(pickIngestPaths(port, "folder")).resolves.toEqual([
      "/data/runs/a.csv",
      "/data/runs/sub/b.csv",
    ]);
    expect(scans).toEqual([["/data/runs", true]]);
  });
});
