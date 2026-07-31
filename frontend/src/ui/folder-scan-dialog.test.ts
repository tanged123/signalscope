// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import { FolderScanDialog } from "./folder-scan-dialog";

afterEach(() => {
  document.body.replaceChildren();
});

describe("FolderScanDialog", () => {
  it("shows scan details and rescans when recursion changes", async () => {
    const scans: boolean[] = [];
    const loaded: string[][] = [];
    const dialog = new FolderScanDialog(document.body);
    dialog.open(
      "/data/runs",
      (recursive) => {
        scans.push(recursive);
        return Promise.resolve(recursive
          ? {
              files: ["a.csv", "sub/b.csv"],
              total_bytes: "2048",
              format_counts: [
                { label: "Delimited text (CSV, TSV, TXT, DAT)", count: 2 },
              ],
            }
          : {
              files: ["a.csv"],
              total_bytes: "1024",
              format_counts: [
                { label: "Delimited text (CSV, TSV, TXT, DAT)", count: 1 },
              ],
            });
      },
      (files) => loaded.push(files),
    );

    await Promise.resolve();
    expect(document.body.textContent).toContain("2 loadable files");
    expect(scans).toEqual([true]);

    const recursive = document.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    recursive?.click();
    await Promise.resolve();
    expect(scans).toEqual([true, false]);
    expect(document.body.textContent).toContain("1 loadable file");

    document.querySelector<HTMLButtonElement>(".folder-scan-load")?.click();
    expect(loaded).toEqual([["a.csv"]]);
    expect(document.querySelector(".folder-scan-overlay")?.hasAttribute("hidden")).toBe(true);
  });

  it("disables loading when no files are found", async () => {
    const dialog = new FolderScanDialog(document.body);
    dialog.open(
      "/data/empty",
      () => Promise.resolve({ files: [], total_bytes: "0", format_counts: [] }),
      () => undefined,
    );

    await Promise.resolve();
    expect(document.body.textContent).toContain("No loadable files found.");
    expect(
      document.querySelector<HTMLButtonElement>(".folder-scan-load")?.disabled,
    ).toBe(true);
  });
});
