import { describe, expect, it } from "vitest";

import type { IngestPort } from "./data-plane";
import { classifyDrop, expandDropPaths, unsupportedDropMessage } from "./drop";

function scanningPort(
  scans: Record<string, string[]>,
  failing: string[] = [],
): IngestPort {
  return {
    scanSources: (path: string) => {
      if (failing.includes(path)) return Promise.reject(new Error("denied"));
      return Promise.resolve({
        files: scans[path] ?? [],
        total_bytes: "0",
        format_counts: [],
      });
    },
    listFormats: () =>
      Promise.resolve([
        { id: "csv", label: "Delimited text", extensions: ["csv", "tsv"] },
        { id: "mcap", label: "MCAP recordings", extensions: ["mcap"] },
      ]),
  } as unknown as IngestPort;
}

describe("classifyDrop", () => {
  it("treats plain files and folders as data", () => {
    expect(classifyDrop(["/data/a.csv", "/data/runs"])).toEqual({
      kind: "data",
      paths: ["/data/a.csv", "/data/runs"],
    });
  });

  it("opens a single workspace file, case-insensitively", () => {
    expect(classifyDrop(["/w/Flight.SIGNALSCOPE"])).toEqual({
      kind: "workspace",
      path: "/w/Flight.SIGNALSCOPE",
    });
    expect(classifyDrop(["/w/flight.json"]).kind).toBe("workspace");
  });

  it("rejects a drop mixing workspace and data files", () => {
    const plan = classifyDrop(["/w/a.signalscope", "/data/a.csv"]);
    expect(plan.kind).toBe("rejected");
  });

  it("rejects multiple workspace files", () => {
    expect(classifyDrop(["/w/a.signalscope", "/w/b.json"]).kind).toBe(
      "rejected",
    );
  });
});

describe("expandDropPaths", () => {
  it("merges, dedupes, and sorts scan results per dropped path", async () => {
    const port = scanningPort({
      "/runs": ["/runs/b.csv", "/runs/a.csv"],
      "/more/a.csv": ["/more/a.csv", "/runs/a.csv"],
    });
    const expansion = await expandDropPaths(port, ["/runs", "/more/a.csv"]);
    expect(expansion.files).toEqual([
      "/more/a.csv",
      "/runs/a.csv",
      "/runs/b.csv",
    ]);
    expect(expansion.failures).toEqual([]);
  });

  it("collects per-path failures while the rest still expand", async () => {
    const port = scanningPort({ "/runs": ["/runs/a.csv"] }, ["/locked"]);
    const expansion = await expandDropPaths(port, ["/locked", "/runs"]);
    expect(expansion.files).toEqual(["/runs/a.csv"]);
    expect(expansion.failures).toEqual(["/locked"]);
  });
});

describe("unsupportedDropMessage", () => {
  it("names every supported extension", async () => {
    const message = await unsupportedDropMessage(scanningPort({}));
    expect(message).toContain(".csv");
    expect(message).toContain(".tsv");
    expect(message).toContain(".mcap");
  });
});
