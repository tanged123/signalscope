import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chooseRun,
  isWsl,
  parseWindowsRunArguments,
  pruneSelection,
} from "./windows-run.mjs";

test("parse defaults", () => {
  assert.deepEqual(parseWindowsRunArguments([]), {
    fresh: false,
    ref: null,
    appArguments: [],
  });
});

test("parse flags and app arguments", () => {
  assert.deepEqual(
    parseWindowsRunArguments([
      "--fresh",
      "--ref",
      "feature/x",
      "--",
      "--user-data-dir=C:\\tmp\\ss",
    ]),
    {
      fresh: true,
      ref: "feature/x",
      appArguments: ["--user-data-dir=C:\\tmp\\ss"],
    },
  );
});

test("parse rejects unknown and malformed arguments", () => {
  assert.throws(() => parseWindowsRunArguments(["--wat"]), /unknown argument/);
  assert.throws(() => parseWindowsRunArguments(["--ref"]), /--ref requires/);
  assert.throws(
    () => parseWindowsRunArguments(["--ref", "--fresh"]),
    /--ref requires/,
  );
});

test("isWsl detects distro name, proc version, and neither", () => {
  assert.equal(isWsl({ WSL_DISTRO_NAME: "Ubuntu" }, ""), true);
  assert.equal(isWsl({}, "Linux version 6.6-microsoft-standard-WSL2"), true);
  assert.equal(isWsl({}, "Linux version 6.6-generic"), false);
});

const run = (overrides) => ({
  databaseId: 1,
  headSha: "abc",
  status: "completed",
  conclusion: "success",
  createdAt: "2026-08-11T00:00:00Z",
  ...overrides,
});

test("chooseRun reuses the newest matching success", () => {
  const old = run({ databaseId: 1, createdAt: "2026-08-10T00:00:00Z" });
  const newer = run({ databaseId: 2, createdAt: "2026-08-11T00:00:00Z" });
  assert.deepEqual(chooseRun([old, newer], "abc"), {
    run: newer,
    action: "reuse",
  });
});

test("chooseRun watches an in-progress matching run", () => {
  const active = run({ status: "in_progress", conclusion: null });
  assert.deepEqual(chooseRun([active], "abc"), {
    run: active,
    action: "watch",
  });
});

test("chooseRun dispatches on no match or newest failure", () => {
  assert.deepEqual(chooseRun([], "abc"), { run: null, action: "dispatch" });
  assert.deepEqual(chooseRun([run({ headSha: "other" })], "abc"), {
    run: null,
    action: "dispatch",
  });
  const failed = run({ conclusion: "failure" });
  assert.deepEqual(chooseRun([failed], "abc"), {
    run: null,
    action: "dispatch",
  });
});

test("pruneSelection keeps the current entry plus the two newest others", () => {
  const entries = [
    { name: "aaa", mtimeMs: 100 },
    { name: "bbb", mtimeMs: 300 },
    { name: "ccc", mtimeMs: 200 },
    { name: "ddd", mtimeMs: 400 },
    { name: "cur", mtimeMs: 50 },
  ];
  assert.deepEqual(pruneSelection(entries, "cur"), ["ccc", "aaa"]);
});

test("pruneSelection deletes nothing under the limit", () => {
  assert.deepEqual(pruneSelection([{ name: "cur", mtimeMs: 1 }], "cur"), []);
});
