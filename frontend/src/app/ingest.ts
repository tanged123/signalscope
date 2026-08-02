import type { BatchStatus } from "../generated/protocol";
import type { IngestPort } from "./data-plane";

const POLL_INTERVAL_MS = 150;

export type SourceOpenKind = "files" | "folder";

export async function pickIngestPaths(
  port: IngestPort,
  kind: SourceOpenKind,
): Promise<string[]> {
  if (kind === "files") return port.pickSources();
  const folder = await port.pickSourceFolder();
  if (folder === null) return [];
  return (await port.scanSources(folder, true)).files;
}

export async function runBatchIngest(
  port: IngestPort,
  paths: string[],
  onProgress: (status: BatchStatus) => void,
  pollIntervalMs: number = POLL_INTERVAL_MS,
): Promise<BatchStatus> {
  const jobId = await port.startBatch(paths);
  try {
    return await waitForBatch(port, jobId, onProgress, pollIntervalMs);
  } finally {
    await port.releaseBatch(jobId);
  }
}

export async function waitForBatch(
  port: IngestPort,
  jobId: string,
  onProgress: (status: BatchStatus) => void,
  pollIntervalMs: number = POLL_INTERVAL_MS,
): Promise<BatchStatus> {
  for (;;) {
    const status = await port.batchStatus(jobId);
    onProgress(status);
    if (status.state !== "running") return status;
    await new Promise((resolve) => {
      setTimeout(resolve, pollIntervalMs);
    });
  }
}
