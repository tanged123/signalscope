import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const reportDir = fileURLToPath(
  new URL("../../../build/bench/report/", import.meta.url),
);

export interface ElectronHardwareReport {
  readonly bench: "electron_hardware";
  readonly backend: string;
  readonly fallback_reason: string | null;
  readonly software_rendering: boolean;
  readonly pass: boolean;
  readonly corpora?: readonly ElectronHardwareReport[];
  readonly [key: string]: unknown;
}

export async function writeElectronHardwareReport(
  report: ElectronHardwareReport,
): Promise<void> {
  const path = `${reportDir}/electron-hardware.json`;
  await mkdir(dirname(path), { recursive: true });
  let combined = report;
  try {
    const previous = JSON.parse(await readFile(path, "utf8")) as
      | ElectronHardwareReport
      | undefined;
    if (previous?.bench === "electron_hardware") {
      const priorReports = previous.corpora ?? [previous];
      combined = {
        ...report,
        pass: previous.pass && report.pass,
        corpora: [...priorReports, report],
      };
    }
  } catch {
    // The first corpus creates the report.
  }
  await writeFile(path, `${JSON.stringify(combined, null, 2)}\n`);
}
