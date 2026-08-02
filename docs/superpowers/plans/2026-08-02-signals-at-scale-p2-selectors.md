# Signals at Scale P2 — Selector + Sets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the selector grammar and full named-set UX: a promoted dock filter box with live match counts, ⏎ add-to-panel, ⌘S save-as-set, set bind by click/drag, and ⌘P signals mode on the same grammar.

**Architecture:** One pure module (`selector.ts`) parses and evaluates the grammar over the P1 `Catalog`; `resolution.ts` swaps its exact-channel matching for selector evaluation; UI surfaces (dock filter, sets list, palette) consume the same two functions. Frontend-only: no Rust, protocol, schema, or codegen changes — v17 already carries `Binding{kind:"query"}` and `NamedSet`.

**Tech Stack:** TypeScript, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-01-signals-at-scale-design.md` (§ "Selector grammar", "Sets"). Read it first. This plan assumes P1 as landed at commit `fdb7425`.

## Global Constraints

- Use `./scripts/` wrappers only: `./scripts/test.sh unit|frontend|e2e [filter]`, `./scripts/format.sh`. Final gate: `./scripts/ci.sh frontend`.
- Do not touch `protocol/schema/*`, generated files, or any Rust. If a task seems to need it, stop and report instead.
- Grammar is exactly three term kinds — channel glob, `@ source-glob`, `key:value` attrs. No boolean operators, negation, or nesting. Valid attr keys in P2: `unit`, `kind` only; anything else is a parse error.
- A glob without wildcards is a literal exact match. This keeps P1's migrated `favorite_bundles` selectors (bare channel names) working unchanged.
- Fallback rule (both dock filter and ⌘P signals): input that fails to parse, or parses to zero matches while containing no glob/attr/source syntax, filters by plain substring on channel and path. Fuzzy subsequence matching for signals is deleted; substring is the only fallback. Commands/settings palette modes keep `fuzzyScore`.
- No new nondeterminism in persisted state: named-set ids are sequential `set-N` (scan existing ids for the max), never `crypto.randomUUID()` or timestamps.
- Amber is interaction-only; every pointer action gets a keyboard path.
- Run `./scripts/format.sh` before staging each commit; stage only intentional files.

---

### Task 1: Selector parser

**Files:**

- Create: `frontend/src/app/selector.ts`
- Test: `frontend/src/app/selector.test.ts`

**Interfaces:**

- Consumes: nothing (pure strings → structures).
- Produces (Tasks 2–6 use these exact names):

```ts
export interface SelectorAttr {
  key: "unit" | "kind";
  value: string;
}
export interface Selector {
  channelText: string;
  channel: RegExp;
  sourceText: string | null;
  source: RegExp | null;
  attrs: readonly SelectorAttr[];
}
export type SelectorParse =
  | { ok: true; selector: Selector }
  | { ok: false; error: string };
export function parseSelector(input: string): SelectorParse;
export function compileGlob(glob: string): RegExp | null; // null on malformed [range]
```

- [ ] **Step 1: Write table-driven failing tests.**

```ts
import { describe, expect, it } from "vitest";
import { compileGlob, parseSelector } from "./selector";

describe("compileGlob", () => {
  const accepts: [string, string[]][] = [
    ["temp", ["temp"]],
    ["derived/temp*", ["derived/temp", "derived/temp_sp"]],
    ["temp?", ["temp1", "tempA"]],
    ["command|response", ["command", "response"]],
    ["run_0[1-3]", ["run_01", "run_02", "run_03"]],
    ["imu/a?", ["imu/ax", "imu/az"]],
  ];
  const rejects: [string, string[]][] = [
    ["temp", ["temperature", "TEMP", "a/temp"]],
    ["derived/temp*", ["temp", "derived2/temp"]],
    ["temp?", ["temp", "temp12"]],
    ["command|response", ["commandx", "respons"]],
    ["run_0[1-3]", ["run_04", "run_0"]],
  ];
  it.each(accepts)("%s accepts %s", (glob, values) => {
    const re = compileGlob(glob);
    for (const value of values) expect(re?.test(value)).toBe(true);
  });
  it.each(rejects)("%s rejects %s", (glob, values) => {
    const re = compileGlob(glob);
    for (const value of values) expect(re?.test(value)).toBe(false);
  });
  it("regex metacharacters in literals are inert", () => {
    expect(compileGlob("a.b")?.test("a.b")).toBe(true);
    expect(compileGlob("a.b")?.test("axb")).toBe(false);
    expect(compileGlob("a+b")?.test("a+b")).toBe(true);
  });
  it("unterminated range is malformed", () => {
    expect(compileGlob("run_[1")).toBeNull();
  });
});

describe("parseSelector", () => {
  it("channel only", () => {
    const parsed = parseSelector("derived/temp*");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.selector.channelText).toBe("derived/temp*");
    expect(parsed.selector.source).toBeNull();
    expect(parsed.selector.attrs).toEqual([]);
  });
  it("channel @ source, detached and attached forms", () => {
    for (const input of ["derived/temp* @ run_*", "derived/temp* @run_*"]) {
      const parsed = parseSelector(input);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.selector.sourceText).toBe("run_*");
      expect(parsed.selector.source?.test("run_07")).toBe(true);
    }
  });
  it("attrs parse and unknown keys error", () => {
    const parsed = parseSelector("temp* @ run_* unit:K kind:derived");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.selector.attrs).toEqual([
        { key: "unit", value: "K" },
        { key: "kind", value: "derived" },
      ]);
    }
    expect(parseSelector("temp foo:bar").ok).toBe(false);
  });
  it("errors: empty input, missing channel, malformed glob, double source", () => {
    expect(parseSelector("").ok).toBe(false);
    expect(parseSelector("@ run_*").ok).toBe(false);
    expect(parseSelector("run_[1").ok).toBe(false);
    expect(parseSelector("a @ b @ c").ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure.** `./scripts/test.sh unit selector` — FAIL (module missing).
- [ ] **Step 3: Implement.**

```ts
export function compileGlob(glob: string): RegExp | null {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i] as string;
    if (ch === "*") out += ".*";
    else if (ch === "?") out += ".";
    else if (ch === "|") out += "|";
    else if (ch === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end === -1) return null;
      const body = glob.slice(i + 1, end);
      if (
        !/^[a-zA-Z0-9_-]+$/.test(body) &&
        !/^[a-zA-Z0-9]-[a-zA-Z0-9]$/.test(body)
      ) {
        return null;
      }
      out += `[${body}]`;
      i = end;
    } else if (/[a-zA-Z0-9_]/.test(ch)) out += ch;
    else out += `\\${ch}`;
  }
  try {
    return new RegExp(`^(?:${out})$`);
  } catch {
    return null;
  }
}

const ATTR_KEYS = new Set(["unit", "kind"]);

export function parseSelector(input: string): SelectorParse {
  const tokens = input
    .trim()
    .split(/\s+/)
    .filter((token) => token !== "");
  if (tokens.length === 0) return { ok: false, error: "empty selector" };
  const attrs: SelectorAttr[] = [];
  let channelText: string | null = null;
  let sourceText: string | null = null;
  let expectSource = false;
  for (const token of tokens) {
    if (expectSource) {
      if (sourceText !== null)
        return { ok: false, error: "duplicate source term" };
      sourceText = token;
      expectSource = false;
    } else if (token === "@") {
      if (sourceText !== null)
        return { ok: false, error: "duplicate source term" };
      expectSource = true;
    } else if (token.startsWith("@")) {
      if (sourceText !== null)
        return { ok: false, error: "duplicate source term" };
      sourceText = token.slice(1);
    } else if (token.includes(":")) {
      const colon = token.indexOf(":");
      const key = token.slice(0, colon);
      if (!ATTR_KEYS.has(key))
        return { ok: false, error: `unknown attribute "${key}"` };
      attrs.push({
        key: key as SelectorAttr["key"],
        value: token.slice(colon + 1),
      });
    } else if (channelText === null) {
      channelText = token;
    } else {
      return { ok: false, error: `unexpected term "${token}"` };
    }
  }
  if (expectSource) return { ok: false, error: "missing source glob after @" };
  if (channelText === null) return { ok: false, error: "missing channel glob" };
  const channel = compileGlob(channelText);
  if (channel === null) return { ok: false, error: "malformed channel glob" };
  let source: RegExp | null = null;
  if (sourceText !== null) {
    source = compileGlob(sourceText);
    if (source === null) return { ok: false, error: "malformed source glob" };
  }
  return {
    ok: true,
    selector: { channelText, channel, sourceText, source, attrs },
  };
}
```

- [ ] **Step 4: Run.** `./scripts/test.sh unit selector` — PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(frontend): selector grammar parser"`

---

### Task 2: Evaluation over the catalog

**Files:**

- Modify: `frontend/src/app/catalog.ts`, `frontend/src/app/catalog.test.ts`
- Modify: `frontend/src/app/selector.ts`, `frontend/src/app/selector.test.ts`

**Interfaces:**

- Produces:

```ts
// catalog.ts — CatalogSeries gains:
sourceName: string; // display prefix before "/" in path; "derived" for derived signals

// selector.ts:
export interface SelectorMatch {
  series: readonly CatalogSeries[];
  signalCount: number; // series.length
  sourceCount: number; // distinct sourceKey count
}
export function seriesMatches(
  selector: Selector,
  series: CatalogSeries,
): boolean;
export function evaluateSelector(
  catalog: Catalog,
  input: string,
): SelectorMatch | null; // null = parse failure
```

Semantics: channel glob tests `series.channel`; source glob tests `series.sourceName` (display names like `run_07`, never UUID keys — the design's `@ run_*` addresses what the user sees); `unit:X` tests `summary.unit` exactly; `kind:derived` tests `sourceKey === DERIVED_SOURCE_KEY`, `kind:signal` the negation; other `kind` values match nothing. No source term ⇒ all sources.

- [ ] **Step 1: Failing tests.** In `catalog.test.ts`: `sourceName` is the path prefix (`run_01/temp` → `run_01`) and `"derived"` for derived signals. In `selector.test.ts` build a small catalog fixture (3 sources `run_01 run_02 bench` × channels `temp temp_sp pressure`, one `derived/err`, units on temp) and cover: channel-only glob spans sources; `@ run_0[1-2]` excludes `bench`; `unit:K` filters; `kind:derived` returns only the derived series; `evaluateSelector` counts (`temp* @ run_*` → signalCount 4, sourceCount 2); parse failure → null; bare literal `temp` matches only channel `temp`.
- [ ] **Step 2: Run.** FAIL.
- [ ] **Step 3: Implement.** `Catalog.build` sets `sourceName` (compute from `summary.path` before the separator; `DERIVED_SOURCE_KEY` when derived). In `selector.ts`:

```ts
export function seriesMatches(
  selector: Selector,
  series: CatalogSeries,
): boolean {
  if (!selector.channel.test(series.channel)) return false;
  if (selector.source !== null && !selector.source.test(series.sourceName))
    return false;
  for (const attr of selector.attrs) {
    if (attr.key === "unit" && series.summary.unit !== attr.value) return false;
    if (attr.key === "kind") {
      const derived = series.sourceKey === DERIVED_SOURCE_KEY;
      if (
        attr.value === "derived"
          ? !derived
          : attr.value === "signal"
            ? derived
            : true
      ) {
        return false;
      }
    }
  }
  return true;
}

export function evaluateSelector(
  catalog: Catalog,
  input: string,
): SelectorMatch | null {
  const parsed = parseSelector(input);
  if (!parsed.ok) return null;
  const series = catalog
    .allSeries()
    .filter((entry) => seriesMatches(parsed.selector, entry));
  return {
    series,
    signalCount: series.length,
    sourceCount: new Set(series.map((entry) => entry.sourceKey)).size,
  };
}
```

- [ ] **Step 4: Run.** `./scripts/test.sh unit "selector|catalog"` — PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(frontend): selector evaluation over the catalog"`

---

### Task 3: Resolution speaks the grammar

**Files:**

- Modify: `frontend/src/app/resolution.ts`, `frontend/src/app/resolution.test.ts`
- Modify: `frontend/src/app/workspace.ts`, `frontend/src/app/workspace.test.ts`

**Interfaces:**

- Changes: `resolution.ts` private `addChannel(catalog, channel, add)` is replaced by `addSelector(catalog, input, add)` built on `evaluateSelector`; public signatures unchanged.
- Produces on `WorkspaceModel` (Tasks 4–6 call these):

```ts
addQueryBinding(panelId: string, selector: string): boolean;  // false when panel missing or an identical query binding exists
addSetBinding(panelId: string, setId: string): boolean;       // false on duplicate
nextSetId(): string;                                          // "set-N", max existing + 1
// removeNamedSet(id) additionally strips {kind:"set", set_id: id} bindings from every panel in every tab
```

- [ ] **Step 1: Failing tests.** `resolution.test.ts`: a `query` binding `temp* @ run_0[1-2]` resolves the globbed subset in catalog order; a query named set with a glob selector resolves likewise; invalid selector resolves to nothing; the existing exact-literal tests stay green (delete none — they now pass through the grammar's literal case). `workspace.test.ts`: `addQueryBinding` appends and dedupes; `addSetBinding` dedupes; `nextSetId` returns `set-1` on empty, `set-4` when `set-3` exists (and ignores non-matching ids like `set-fav-2`? No — `set-fav-N` ids from migration match the scan too; scan `/^set(?:-fav)?-(\d+)$/` and take max); `removeNamedSet` strips set bindings across tabs.
- [ ] **Step 2: Run.** FAIL.
- [ ] **Step 3: Implement.** In `resolution.ts` replace `addChannel` with:

```ts
function addSelector(
  catalog: Catalog,
  input: string,
  add: (ref: SeriesRef) => void,
): void {
  const match = evaluateSelector(catalog, input);
  if (match === null) return;
  for (const series of match.series) {
    add({ source_key: series.sourceKey, channel: series.channel });
  }
}
```

and call it for `query` bindings and `query` sets. In `workspace.ts` implement the three methods plus the `removeNamedSet` sweep, following the file's existing style (no clones of live state, mutate in place).

- [ ] **Step 4: Run.** `./scripts/test.sh unit "resolution|workspace"` — PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(frontend): query bindings and sets resolve through the selector grammar"`

---

### Task 4: Dock filter box promotion

**Files:**

- Modify: `frontend/src/ui/app-shell.ts` (shell markup ~2756, `.signal-search` listener ~1131, `focus-filter` command ~702), `frontend/src/ui/signal-tree.ts`, `frontend/src/app/tree-model.ts`, `frontend/src/app/tree-model.test.ts`, `frontend/src/styles/*` (dock styles file — locate with `grep -rn "signal-search" frontend/src/styles`)

**Interfaces:**

- Consumes: `evaluateSelector`, `WorkspaceModel.addQueryBinding`, `addNamedSet`, `nextSetId`.
- Produces: `buildTreeRows(catalog, collapsed, filter)` where `filter` is interpreted as selector-first with substring fallback (Global Constraints rule); a `.search-count` line under the input; ⏎ and ⌘S behaviors on the input.

- [ ] **Step 1: Failing tree tests.** In `tree-model.test.ts`: filter `temp* @ run_01` shows only run_01 members of temp-channels; filter `temp` (literal, matches channel `temp`) shows that channel; filter `xyz[` (malformed) falls back to substring and matches nothing/paths containing `xyz[`; filter `emp` (valid parse, zero matches, no syntax chars) falls back to substring and matches `temp` rows.
- [ ] **Step 2: Implement filter semantics** in `tree-model.ts`: try `evaluateSelector(catalog, query)`; when it returns non-null with matches — or the input contains any of `*?|[@:` — the match set (as a `Set` of `catalog.refKey(...)`) drives row inclusion; otherwise keep the existing substring branch. Run: PASS.
- [ ] **Step 3: Count line.** In `shellMarkup()` add `<div class="search-count"></div>` under the search label. In the input listener: valid selector → `16 signals · 8 sources` text plus a `⏎ add · ⌘S set` hint span (`--fg-3` mono 10px per the design mock; reuse existing dock footer text styles); empty input → empty element; fallback mode → `N matches` from the tree's substring count. Update it on `reloadSignals()` too (catalog changes).
- [ ] **Step 4: ⏎ adds to panel.** Keydown on `.signal-search`: `Enter` with a valid selector and ≥1 match → `addQueryBinding(focusedPanelId, input)`; when no panel is focused, `addPanelRow()` first; then the same refresh path the drop handler uses (find it via the `SIGNAL_DRAG_TYPE` drop in `panel.ts` → whatever callback it invokes on the shell). Input keeps focus and content.
- [ ] **Step 5: ⌘S saves a set.** Keydown `s` with `metaKey||ctrlKey` while the input is focused and the selector is valid: `preventDefault()`/`stopPropagation()` (this intentionally shadows any global save binding while the box is focused), reveal an inline `.set-name-row` (hidden input + OK/cancel) directly under the count line; `Enter` commits `addNamedSet({id: nextSetId(), name, kind: "query", selector: input, refs: []})` and re-renders the sets list; `Escape` cancels and returns focus to the search box. Keyboard-only operation must work end to end.
- [ ] **Step 6: Run.** `./scripts/test.sh unit` then `./scripts/test.sh frontend` — PASS.
- [ ] **Step 7: Commit.** `git commit -m "feat(ui): dock filter box is a selector — live counts, enter-to-bind, cmd-s save-as-set"`

---

### Task 5: Sets UX — badges, counts, bind by click and drag, delete

**Files:**

- Modify: `frontend/src/ui/signal-tree.ts`, `frontend/src/ui/signal-tree.test.ts`, `frontend/src/ui/panel.ts`, `frontend/src/ui/panel.test.ts`, `frontend/src/ui/app-shell.ts` (set-selected callback)

**Interfaces:**

- Produces: `export const SET_DRAG_TYPE = "application/x-signalscope-set"` (in `panel.ts` beside `SIGNAL_DRAG_TYPE`), drag payload `JSON.stringify({set_id})`; panel drop of that type calls the shell's bind callback → `addSetBinding`.
- Changes: sets list rows show `★ name · <selector-or-count>` with a kind badge — query sets: live match count from the catalog (`16`) and a `live` title; pick sets: `▣ N` frozen badge (matches the design mock's `manual pick · 3 ▣`). Row click binds the set to the focused panel (both kinds — bind by reference, never expansion). A `✕` affordance per row deletes the set (`removeNamedSet`), reachable by keyboard (row focused + `Delete`).

- [ ] **Step 1: Failing view tests.** `signal-tree.test.ts`: query set row shows live count computed against a catalog where the selector matches 3 series; pick set row shows `▣ 2`; clicking a row fires `onSetBind(set.id)`; Delete key on a focused row fires `onSetRemove(set.id)`; rows carry `draggable="true"` and `dragstart` sets `SET_DRAG_TYPE` with `{set_id}`.
- [ ] **Step 2: Implement** in `signal-tree.ts` `renderSets()` (the view already receives the catalog for `dragPayload` — reuse it for live counts via `evaluateSelector`). Rename the callback `onSetSelected` → `onSetBind`; add `onSetRemove`. Wire both in `app-shell.ts`: `onSetBind` → `addSetBinding(focusedPanelId ?? addPanelRow().id, setId)` + refresh; `onSetRemove` → `removeNamedSet` + re-render sets.
- [ ] **Step 3: Panel drop.** In `panel.ts`, extend the drop/dragover handlers (~415–460) to accept `SET_DRAG_TYPE` with the same amber drop-target treatment as signals; on drop parse `{set_id}` and invoke the shell callback that performs `addSetBinding`. Test in `panel.test.ts` mirroring the existing signal-drop test.
- [ ] **Step 4: Run.** `./scripts/test.sh unit "signal-tree|panel"` — PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(ui): named sets bind by click and drag, show live counts, delete in place"`

---

### Task 6: ⌘P signals mode on the grammar

**Files:**

- Modify: `frontend/src/ui/command-palette.ts`, `frontend/src/ui/command-palette.test.ts` (create if absent), `frontend/src/ui/app-shell.ts` (`paletteEntries` ~1028–1112)

**Interfaces:**

- Changes: `CommandPalette` filtering becomes mode-aware. `commands`/`settings`: `fuzzyScore` exactly as today. `signals`: the query goes through `evaluateSelector` against a matcher callback the shell provides; fallback per the Global Constraints rule (substring on title). Delete the fuzzy path for signals.
- Produces: when a signals-mode query is a valid selector matching >1 series, the first entry is `Add N signals · M sources to focused panel` and runs `addQueryBinding` with the raw query; the per-series entries below it (existing cap 12) keep their current run actions.

- [ ] **Step 1: Failing tests.** Palette in signals mode with entries `run_01/temp`, `run_02/temp`, `bench/pressure`: query `temp @ run_*` lists the aggregate entry first then exactly the two temp entries; query `press` (fallback) lists `bench/pressure`; query in commands mode still fuzzy-matches (subsequence `tgf` → `toggle-formula`-style titles).
- [ ] **Step 2: Implement.** Give `PaletteEntry` an optional `match` payload or let `paletteEntries("signals")` receive the raw query — choose the smaller diff given the file's shape (entries are currently pre-built then fuzzy-filtered at ~106; move signal filtering into the shell's entry supplier, which already closes over the catalog and workspace). The aggregate entry is built there too.
- [ ] **Step 3: Run.** `./scripts/test.sh unit` — PASS. Verify `grep -n "fuzzyScore" frontend/src/ui/command-palette.ts` shows it applied only when `mode !== "signals"`.
- [ ] **Step 4: Commit.** `git commit -m "feat(ui): palette signals mode speaks the selector grammar"`

---

### Task 7: E2E, docs, gate, version

**Files:**

- Modify: `frontend/tests/e2e/workbench.spec.ts` (or a new `selectors.spec.ts` beside it), `docs/implementation-roadmap.md`, version manifests via script.

- [ ] **Step 1: Playwright coverage** (follow `fixtures.ts` conventions): type `temp* @ run_*` in the dock box → count line shows expected numbers; press Enter → focused panel legend shows the matched series; ⌘S → name it `thermal` → row appears with live count; drag the set row onto a second panel → it plots; delete the set → bindings referencing it resolve to nothing and the panel empties (assert no crash, empty legend).
- [ ] **Step 2:** Roadmap: one sentence under the Phase 5/audit section — P2 of the signals-at-scale spec landed (selector grammar, named-set UX, palette unification).
- [ ] **Step 3: Full gate.** `./scripts/ci.sh frontend` — PASS.
- [ ] **Step 4: Version.** `./scripts/version.sh bump minor && ./scripts/version.sh check`, commit manifests.
- [ ] **Step 5: Commit + handoff report.** Changed files, commands run, anything open.

---

## Self-review notes (already applied)

- Spec coverage: grammar+EBNF ✓ (T1), five call sites — dock filter ✓ (T4), ⌘P ✓ (T6), set definitions ✓ (T3/T5), override targets (P3, by design), table filter (P4, by design); ⏎ add ✓, ⌘S save ✓, drag-to-bind ✓, query/pick badges ✓, fuzzy-for-signals deleted ✓ (T6), substring filter replaced with selector-first ✓ (T4).
- Judgment calls locked (do not revisit during execution): source globs match display names, not UUID keys; substring is the sole fallback and the fallback is intentional (mid-typing UX), fuzzy dies; set ids stay deterministic `set-N`; deleting a set leaves dangling `set` bindings resolving to empty (P4's table may add cleanup affordances); ⌘S shadows global save only while the box is focused.
- Type consistency: `SelectorMatch`/`evaluateSelector`/`seriesMatches` names match across T2–T6; `SET_DRAG_TYPE` lives in `panel.ts` beside the existing drag constants; `onSetBind`/`onSetRemove` used consistently in T5.
