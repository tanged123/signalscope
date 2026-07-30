import type { BatchStatus } from "../generated/protocol";
import type { IngestPort } from "./data-plane";

const POLL_INTERVAL_MS = 150;

export async function runBatchIngest(
  port: IngestPort,
  paths: string[],
  onProgress: (status: BatchStatus) => void,
  pollIntervalMs: number = POLL_INTERVAL_MS,
): Promise<BatchStatus> {
  const jobId = await port.startBatch(paths);
  try {
    for (;;) {
      const status = await port.batchStatus(jobId);
      onProgress(status);
      if (status.state !== "running") return status;
      await new Promise((resolve) => {
        setTimeout(resolve, pollIntervalMs);
      });
    }
  } finally {
    await port.releaseBatch(jobId);
  }
}
