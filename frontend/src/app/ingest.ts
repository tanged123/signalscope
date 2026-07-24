import type { IngestResponse, IngestStatus } from "../generated/protocol";
import type { IngestPort } from "./data-plane";

const POLL_INTERVAL_MS = 150;

export async function runIngest(
  port: IngestPort,
  path: string,
  onProgress: (status: IngestStatus) => void,
  pollIntervalMs: number = POLL_INTERVAL_MS,
): Promise<IngestResponse> {
  const jobId = await port.start(path);
  for (;;) {
    const status = await port.status(jobId);
    onProgress(status);
    if (status.state === "done") {
      if (status.response === null) {
        throw new Error("Ingest finished without a response");
      }
      return status.response;
    }
    if (status.state === "failed") {
      throw new Error(status.error ?? "Ingest failed");
    }
    await new Promise((resolve) => {
      setTimeout(resolve, pollIntervalMs);
    });
  }
}
