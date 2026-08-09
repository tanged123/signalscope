import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  electronVersionPolicy,
  parseElectronLockVersion,
  readElectronVersion,
} from "./check-electron-version.mjs";

const packageJson = JSON.stringify({ devDependencies: { electron: "43.2.0" } });
const lockfile = `importers:
  desktop:
    devDependencies:
      electron:
        specifier: 43.2.0
        version: 43.2.0
packages:
  electron@43.2.0:
    resolution: {integrity: sha512-test}
`;

assert.equal(parseElectronLockVersion(lockfile), "43.2.0");
assert.equal(
  electronVersionPolicy({ packageJson, lockfile, binaryVersion: "v43.2.0" }).ok,
  true,
);
assert.equal(
  electronVersionPolicy({ packageJson, lockfile, binaryVersion: "v43.1.0" }).ok,
  false,
);
assert.equal(
  electronVersionPolicy({
    packageJson,
    lockfile: lockfile.replaceAll("43.2.0", "43.1.0"),
    binaryVersion: "v43.2.0",
  }).ok,
  false,
);

assert.throws(() => readElectronVersion(), /absolute path/);
assert.throws(() => readElectronVersion("electron"), /absolute path/);

const root = mkdtempSync(join(tmpdir(), "signalscope-electron-version-"));
const failingBinary = join(root, "electron");
writeFileSync(failingBinary, "#!/bin/sh\nexit 7\n");
chmodSync(failingBinary, 0o755);
assert.throws(() => readElectronVersion(failingBinary), /status 7/);

console.log("Electron version policy tests passed.");
