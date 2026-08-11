export const CACHE_LIMIT = 3;

export function parseWindowsRunArguments(argv) {
  const result = { fresh: false, ref: null, appArguments: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      result.appArguments = argv.slice(index + 1);
      break;
    }
    if (argument === "--fresh") {
      result.fresh = true;
      continue;
    }
    if (argument === "--ref") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--ref requires a branch name");
      }
      result.ref = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  return result;
}

export function isWsl(environment, procVersion) {
  if ((environment.WSL_DISTRO_NAME ?? "") !== "") return true;
  return /microsoft/i.test(procVersion);
}

export function chooseRun(runs, headSha) {
  const matching = runs
    .filter((run) => run.headSha === headSha)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const newest = matching[0];
  if (newest === undefined) return { run: null, action: "dispatch" };
  if (newest.status !== "completed") return { run: newest, action: "watch" };
  if (newest.conclusion === "success") return { run: newest, action: "reuse" };
  return { run: null, action: "dispatch" };
}

export function pruneSelection(entries, keepName, limit = CACHE_LIMIT) {
  return entries
    .filter((entry) => entry.name !== keepName)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(Math.max(0, limit - 1))
    .map((entry) => entry.name);
}
