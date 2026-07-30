import { describe, expect, it } from "vitest";

import type { IngestResponse, IngestStatus } from "../generated/protocol";
import type { IngestPort } from "./data-plane";
import { runIngest } from "./ingest";

const response: IngestResponse = {
  source: {
    source_id: "1",
    source_key: "00000000-0000-0000-0000-000000000001",
    prefix: "flight",
    path: "/tmp/flight.csv",
    point_count: "10",
  },
  signals: [],
};

function fakePort(statuses: IngestStatus[]): IngestPort {
  const queue = [...statuses];
  return {
    pickSources: () => Promise.resolve([]),
    startBatch: () => Promise.resolve("7"),
    batchStatus: () =>
      Promise.resolve({
        state: "done",
        fraction: 1,
        total: "0",
        done: "0",
        failed: "0",
        recent_failures: [],
      }),
    batchDetail: () => Promise.resolve({ entries: [], total: "0" }),
    cancelBatch: () => Promise.resolve(),
    releaseBatch: () => Promise.resolve(),
    listFormats: () => Promise.resolve([]),
    start: () => Promise.resolve("7"),
    status: () => {
      const next = queue.shift();
      if (next === undefined) throw new Error("status queue exhausted");
      return Promise.resolve(next);
    },
  };
}

const running = (
  stage: IngestStatus["stage"],
  fraction: number,
): IngestStatus => ({
  state: "running",
  stage,
  fraction,
  response: null,
  error: null,
});

describe("runIngest", () => {
  it("polls until done and reports every status", async () => {
    const seen: IngestStatus[] = [];
    const port = fakePort([
      running("decode", 0.5),
      running("pyramid", 1),
      { state: "done", stage: "cache", fraction: 1, response, error: null },
    ]);
    const result = await runIngest(
      port,
      "/tmp/flight.csv",
      (status) => seen.push(status),
      0,
    );
    expect(result).toEqual(response);
    expect(seen.map((status) => status.stage)).toEqual([
      "decode",
      "pyramid",
      "cache",
    ]);
  });

  it("throws the job error on failure", async () => {
    const port = fakePort([
      {
        state: "failed",
        stage: "decode",
        fraction: 0,
        response: null,
        error: "boom",
      },
    ]);
    await expect(
      runIngest(port, "/tmp/flight.csv", () => undefined, 0),
    ).rejects.toThrow("boom");
  });
});
