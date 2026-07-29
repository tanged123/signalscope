const STORAGE_KEY = "signalscope.command-usage.v1";
const MAX_TRACKED = 50;
const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

interface UsageRecord {
  count: number;
  lastUsed: number;
}

type UsageTable = Record<string, UsageRecord>;

function isUsageTable(value: unknown): value is UsageTable {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  return Object.values(value).every(
    (entry) =>
      entry !== null &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      Number.isInteger((entry as Partial<UsageRecord>).count) &&
      ((entry as Partial<UsageRecord>).count ?? -1) >= 0 &&
      Number.isFinite((entry as Partial<UsageRecord>).lastUsed) &&
      ((entry as Partial<UsageRecord>).lastUsed ?? -1) >= 0,
  );
}

/** localStorage when available; storage access can throw in locked-down
 * webviews, and frecency is disposable, so failures degrade to null. */
export function browserStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

/**
 * Disposable command-usage ranking for the palette. Deliberately not part
 * of the preferences file: it is a cache, not user state (ADR 0023).
 */
export class CommandUsage {
  private table: UsageTable | null = null;

  constructor(
    private readonly storage: Pick<Storage, "getItem" | "setItem"> | null,
    private readonly now: () => number,
  ) {}

  record(id: string): void {
    const table = this.load();
    const entry = table[id] ?? { count: 0, lastUsed: 0 };
    table[id] = { count: entry.count + 1, lastUsed: this.now() };
    const ids = Object.keys(table);
    if (ids.length > MAX_TRACKED) {
      ids.sort((a, b) => (table[a]?.lastUsed ?? 0) - (table[b]?.lastUsed ?? 0));
      for (const stale of ids.slice(0, ids.length - MAX_TRACKED)) {
        Reflect.deleteProperty(table, stale);
      }
    }
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(table));
    } catch {
      // Storage full or unavailable; in-memory ranking still works.
    }
  }

  /** Use-count halved for every week since last use; 0 for unknown ids. */
  score(id: string): number {
    const entry = this.load()[id];
    if (entry === undefined) return 0;
    const age = Math.max(0, this.now() - entry.lastUsed);
    return entry.count * 0.5 ** (age / HALF_LIFE_MS);
  }

  private load(): UsageTable {
    if (this.table === null) {
      try {
        const raw = this.storage?.getItem(STORAGE_KEY);
        const parsed: unknown = raw == null ? {} : JSON.parse(raw);
        this.table = isUsageTable(parsed) ? parsed : {};
      } catch {
        this.table = {};
      }
    }
    return this.table;
  }
}
