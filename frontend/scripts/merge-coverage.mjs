import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { convert } from "ast-v8-to-istanbul";
import libCoverage from "istanbul-lib-coverage";
import libReport from "istanbul-lib-report";
import reports from "istanbul-reports";
import { parseAstAsync } from "vite";

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coverageRoot = resolve(frontendRoot, "../build/coverage/frontend");
const unitCoveragePath = join(coverageRoot, "coverage-final.json");
const playwrightCoveragePath = join(coverageRoot, "playwright.json");

const unitCoverage = JSON.parse(await readFile(unitCoveragePath, "utf8"));
const playwrightCoverage = JSON.parse(
  await readFile(playwrightCoveragePath, "utf8"),
);
const coverageMap = libCoverage.createCoverageMap(unitCoverage);
const browserCoverageMap = libCoverage.createCoverageMap({});
const attachments = coverageAttachments(playwrightCoverage.suites);

if (attachments.length === 0) {
  throw new Error("Playwright produced no JavaScript coverage attachments");
}

for (const attachment of attachments) {
  const entries = JSON.parse(
    Buffer.from(attachment.body, "base64").toString("utf8"),
  );
  for (const entry of entries) {
    const sourcePath = resolve(
      frontendRoot,
      new URL(entry.url).pathname.replace(/^\//, ""),
    );
    const converted = libCoverage.createCoverageMap(
      await convert({
        ast: parseAstAsync(entry.source),
        code: entry.source,
        coverage: {
          ...entry,
          url: pathToFileURL(sourcePath).href,
        },
      }),
    );
    for (const file of converted.files()) {
      const fileCoverage = converted.fileCoverageFor(file).toJSON();
      fileCoverage.path = sourcePath;
      browserCoverageMap.addFileCoverage(fileCoverage);
    }
  }
}

coverageMap.merge(browserCoverageMap);
await writeFile(
  unitCoveragePath,
  `${JSON.stringify(coverageMap.toJSON())}\n`,
  "utf8",
);
const context = libReport.createContext({
  coverageMap,
  dir: coverageRoot,
});
reports.create("lcovonly").execute(context);
reports.create("text-summary").execute(context);

function coverageAttachments(suites) {
  const attachments = [];
  for (const suite of suites) {
    attachments.push(...coverageAttachments(suite.suites ?? []));
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        for (const result of test.results ?? []) {
          attachments.push(
            ...(result.attachments ?? []).filter(
              (attachment) => attachment.name === "js-coverage",
            ),
          );
        }
      }
    }
  }
  return attachments;
}
