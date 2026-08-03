# Drag-and-Drop Ingest and Direct Open Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Window-wide drag-and-drop of data files, folders, and workspace
files, with `Open…` going straight to the native file picker and the
files/folder chooser modal deleted.

**Architecture:** The Tauri window forwards native drag-drop events to the
webview as a typed, envelope-wrapped protocol event (the protocol's first
push-style surface). The frontend listens through the raw
`__TAURI_INTERNALS__` event plugin — the enforced zero-runtime-dependency
policy (`frontend/scripts/check-runtime-deps.mjs`) forbids `@tauri-apps/api`.
Drop classification and folder expansion are pure frontend modules over the
existing `scan_sources` command and batch ingest path.

**Tech Stack:** Rust 2024 Tauri shell, versioned JSON protocol schema with
codegen, TypeScript frontend, vitest (jsdom).

**Spec:** `docs/superpowers/specs/2026-08-02-dragdrop-and-direct-open-design.md`

## Global Constraints

- Every command goes through `./scripts/*` (`test.sh`, `codegen.sh`,
  `format.sh`, `ci.sh`, `version.sh`).
- `protocol/schema/*.json` is the single schema source; never hand-edit
  generated Rust or TypeScript; keep `pnpm codegen:check` green.
- `frontend/package.json` must not declare runtime dependencies
  (`check-runtime-deps.mjs` fails CI otherwise).
- The snapshot host stays inert: `BakedPlane.ingest` remains `null`, and no
  drop plumbing may run when `plane.ingest === null`.
- Untrusted strings (dropped paths, format labels) render via `textContent`,
  never concatenated into HTML.
- Preserve the two-host `DataPlane` architecture: the renderer talks only to
  ports, never to Tauri APIs directly.

---

## File Structure

| File                                        | Change | Responsibility                                        |
| ------------------------------------------- | ------ | ----------------------------------------------------- |
| `protocol/schema/scope-protocol.json`       | Modify | `DragDropKind`, `DragDropForward`, version 15.        |
| `shell/src-tauri/src/lib.rs`                | Modify | Forward window drag-drop events; `drag_forward`.      |
| `frontend/src/app/data-plane.ts`            | Modify | `IngestPort.onDragDrop`, raw event-plugin listen.     |
| `frontend/src/app/drop.ts`                  | Create | Drop classification, expansion, unsupported message.  |
| `frontend/src/app/drop.test.ts`             | Create | Tests for the above.                                  |
| `frontend/src/ui/app-shell.ts`              | Modify | Overlay, modal guard, drop routing, direct open.      |
| `frontend/src/ui/source-open-dialog.ts`     | Delete | Chooser modal dies.                                   |
| `frontend/src/ui/source-open-dialog.test.ts`| Delete | With it.                                              |
| `frontend/src/styles/app.css`               | Modify | `.drop-overlay` styles; delete `.source-open-*`.      |
| `docs/adr/0032-drag-drop-event-forwarding.md`| Create| Record the push-event protocol surface.               |

---

### Task 1: Protocol event payload and Rust drag-drop forwarding

**Files:**

- Modify: `protocol/schema/scope-protocol.json`
- Modify: `shell/src-tauri/src/lib.rs` (helper near `scan_sources` at :531,
  builder in `pub fn run()` at :1496)
- Regenerate: `./scripts/codegen.sh` outputs

**Interfaces:**

- Produces: protocol types `DragDropKind` (`enter | drop | leave`) and
  `DragDropForward { kind: DragDropKind, paths: string[] }`;
  `fn drag_forward(kind: DragDropKind, paths: &[std::path::PathBuf]) -> Envelope<DragDropForward>`;
  the shell emits `Envelope<DragDropForward>` on event `scope://drag-drop`.
  Task 2 consumes the event name and payload type verbatim.

- [ ] **Step 1: Add the schema types and regenerate**

In `protocol/schema/scope-protocol.json`, bump `"protocol_version"` from `14`
to `15` and add to `"types"` (alongside the other enum types):

```json
"DragDropKind": {
  "kind": "enum",
  "variants": ["enter", "drop", "leave"]
},
"DragDropForward": {
  "kind": "object",
  "fields": {
    "kind": "DragDropKind",
    "paths": "string[]"
  }
}
```

Run: `./scripts/codegen.sh`
Expected: generated Rust and TypeScript gain both types; `pnpm codegen:check`
is green.

- [ ] **Step 2: Write the failing test**

In the existing `#[cfg(test)]` module of `shell/src-tauri/src/lib.rs`:

```rust
    #[test]
    fn drag_forwarding_serializes_kind_and_display_paths() {
        let payload = drag_forward(
            DragDropKind::Drop,
            &[std::path::PathBuf::from("/data/run 01.csv")],
        );
        let opened = payload.open().unwrap();
        assert!(matches!(opened.kind, DragDropKind::Drop));
        assert_eq!(opened.paths, ["/data/run 01.csv"]);

        let leave = drag_forward(DragDropKind::Leave, &[]).open().unwrap();
        assert!(leave.paths.is_empty());
    }
```

- [ ] **Step 3: Run it to verify it fails**

Run: `./scripts/test.sh shell drag_forward`
Expected: FAIL — `drag_forward` not found.

- [ ] **Step 4: Implement the helper and the forwarding**

```rust
/// Envelope payload for a forwarded window drag-drop event. Paths use
/// `display()` like every other path the shell hands the frontend.
fn drag_forward(kind: DragDropKind, paths: &[std::path::PathBuf]) -> Envelope<DragDropForward> {
    Envelope::new(DragDropForward {
        kind,
        paths: paths.iter().map(|path| path.display().to_string()).collect(),
    })
}
```

In `pub fn run()`, on the `tauri::Builder` chain (after
`.plugin(tauri_plugin_dialog::init())`):

```rust
        .on_window_event(|window, event| {
            use tauri::{DragDropEvent, Emitter, WindowEvent};
            let WindowEvent::DragDrop(event) = event else { return };
            let payload = match event {
                DragDropEvent::Enter { paths, .. } => drag_forward(DragDropKind::Enter, paths),
                DragDropEvent::Drop { paths, .. } => drag_forward(DragDropKind::Drop, paths),
                DragDropEvent::Leave => drag_forward(DragDropKind::Leave, &[]),
                // Over fires at pointer-move frequency; never forwarded.
                _ => return,
            };
            let _ = window.emit("scope://drag-drop", payload);
        })
```

Import `DragDropKind` and `DragDropForward` from the generated protocol module
the same way the file imports its other generated types.

- [ ] **Step 5: Run the tests**

Run: `./scripts/test.sh shell drag_forward` then `./scripts/test.sh shell`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add protocol shell/src-tauri/src/lib.rs core frontend/src/generated
git commit -m "feat(shell): forward window drag-drop events over the protocol"
```

---

### Task 2: Frontend event listening through the ingest port

**Files:**

- Modify: `frontend/src/app/data-plane.ts`
- Test: `frontend/src/app/data-plane.test.ts`

**Interfaces:**

- Consumes: event `scope://drag-drop` carrying `Envelope<DragDropForward>`
  (Task 1); `open`/`seal` from `./envelope`.
- Produces: `IngestPort.onDragDrop(handler: (event: DragDropForward) => void): () => void`
  (returns an unsubscribe); `TauriInternals` gains `transformCallback`;
  `TauriPlane` constructor becomes
  `constructor(invoke: TauriInternals["invoke"], transformCallback: TauriInternals["transformCallback"])`.
  Tasks 3–4 consume `onDragDrop` and the `DragDropForward` type.

- [ ] **Step 1: Write the failing test**

In `frontend/src/app/data-plane.test.ts` (match the file's existing fake
`invoke` style):

```ts
describe("onDragDrop", () => {
  function dragPlane() {
    const calls: { command: string; args?: Record<string, unknown> }[] = [];
    let registered: ((raw: { payload: unknown }) => void) | null = null;
    const invoke = async (command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      return 7 as never; // event id from plugin:event|listen
    };
    const transformCallback = (callback: (raw: { payload: unknown }) => void) => {
      registered = callback;
      return 42;
    };
    const plane = new TauriPlane(invoke, transformCallback);
    return { plane, calls, deliver: (payload: unknown) => registered?.({ payload }) };
  }

  it("subscribes through the event plugin and opens envelope payloads", async () => {
    const { plane, calls, deliver } = dragPlane();
    const seen: DragDropForward[] = [];
    plane.ingest.onDragDrop((event) => seen.push(event));
    await Promise.resolve();

    const listen = calls.find((call) => call.command === "plugin:event|listen");
    expect(listen?.args?.event).toBe("scope://drag-drop");
    deliver(seal<DragDropForward>({ kind: "drop", paths: ["/data/a.csv"] }));
    expect(seen).toEqual([{ kind: "drop", paths: ["/data/a.csv"] }]);
  });

  it("unlistens with the registered event id on unsubscribe", async () => {
    const { plane, calls } = dragPlane();
    const unsubscribe = plane.ingest.onDragDrop(() => undefined);
    await Promise.resolve();
    unsubscribe();
    await Promise.resolve();

    const unlisten = calls.find((call) => call.command === "plugin:event|unlisten");
    expect(unlisten?.args?.eventId).toBe(7);
  });
});
```

Add `DragDropForward` to the generated-protocol type imports and `seal` to
the envelope imports at the top of the test file if absent.

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh unit data-plane`
Expected: FAIL — `onDragDrop` missing / constructor arity.

- [ ] **Step 3: Implement it**

In `data-plane.ts`:

```ts
interface TauriInternals {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  transformCallback<T>(callback: (payload: T) => void): number;
}
```

Add to `IngestPort`:

```ts
  /** Forwarded window drag-drop events. Returns an unsubscribe. */
  onDragDrop(handler: (event: DragDropForward) => void): () => void;
```

Change the `TauriPlane` constructor signature to
`constructor(private readonly invoke: TauriInternals["invoke"], private readonly transformCallback: TauriInternals["transformCallback"])`
and implement inside the `this.ingest = { ... }` literal:

```ts
      onDragDrop: (handler) => {
        let eventId: number | null = null;
        let disposed = false;
        const unlisten = () => {
          if (eventId === null) return;
          void this.invoke("plugin:event|unlisten", {
            event: "scope://drag-drop",
            eventId,
          });
          eventId = null;
        };
        void this.invoke<number>("plugin:event|listen", {
          event: "scope://drag-drop",
          target: { kind: "Any" },
          handler: this.transformCallback(
            (raw: { payload: Envelope<DragDropForward> }) => {
              handler(open(raw.payload));
            },
          ),
        }).then((id) => {
          eventId = id;
          if (disposed) unlisten();
        });
        return () => {
          disposed = true;
          unlisten();
        };
      },
```

Update `selectDataPlane`:

```ts
export function selectDataPlane(): DataPlane {
  const internals = window.__TAURI_INTERNALS__;
  return internals === undefined
    ? BakedPlane.fromDocument()
    : new TauriPlane(
        internals.invoke.bind(internals),
        internals.transformCallback.bind(internals),
      );
}
```

Add `DragDropForward` to the generated-protocol imports. Fix every other
`new TauriPlane(...)` construction in tests to pass a second argument
(`() => 0` suffices where drag-drop is not exercised), and every test fake of
`IngestPort` to add `onDragDrop: () => () => undefined`.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh unit data-plane` then `./scripts/test.sh frontend`
Expected: PASS (the frontend suite catches any `IngestPort` fake missing the
new member).

- [ ] **Step 5: Commit**

```bash
git add frontend/src
git commit -m "feat(frontend): expose forwarded drag-drop events on the ingest port"
```

---

### Task 3: Drop classification and expansion

**Files:**

- Create: `frontend/src/app/drop.ts`
- Test: `frontend/src/app/drop.test.ts`

**Interfaces:**

- Consumes: `IngestPort.scanSources(path, recursive)` and
  `IngestPort.listFormats()` (existing).
- Produces:
  `DropPlan = { kind: "workspace"; path: string } | { kind: "data"; paths: string[] } | { kind: "rejected"; message: string }`;
  `classifyDrop(paths: string[]): DropPlan`;
  `DropExpansion = { files: string[]; failures: string[] }`;
  `expandDropPaths(port: IngestPort, paths: string[]): Promise<DropExpansion>`;
  `unsupportedDropMessage(port: IngestPort): Promise<string>`.
  Task 4 consumes all three functions.

- [ ] **Step 1: Write the failing test**

`frontend/src/app/drop.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh unit drop`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement it**

`frontend/src/app/drop.ts`:

```ts
import type { IngestPort } from "./data-plane";

/**
 * Workspace files by extension. A dropped folder named `runs.json` would
 * misclassify — the frontend cannot stat — and then fail loudly in the
 * session loader, which is the accepted behavior for that edge.
 */
const WORKSPACE_EXTENSIONS = new Set(["signalscope", "json"]);

export type DropPlan =
  | { kind: "workspace"; path: string }
  | { kind: "data"; paths: string[] }
  | { kind: "rejected"; message: string };

export interface DropExpansion {
  files: string[];
  failures: string[];
}

export function classifyDrop(paths: string[]): DropPlan {
  const workspace = paths.filter((path) =>
    WORKSPACE_EXTENSIONS.has(extensionOf(path)),
  );
  if (workspace.length === 0) return { kind: "data", paths };
  const only = workspace[0];
  if (workspace.length === 1 && paths.length === 1 && only !== undefined) {
    return { kind: "workspace", path: only };
  }
  return {
    kind: "rejected",
    message: "drop either one workspace file or data files, not both",
  };
}

export async function expandDropPaths(
  port: IngestPort,
  paths: string[],
): Promise<DropExpansion> {
  const merged = new Set<string>();
  const failures: string[] = [];
  for (const path of paths) {
    try {
      for (const file of (await port.scanSources(path, true)).files) {
        merged.add(file);
      }
    } catch {
      failures.push(path);
    }
  }
  return { files: [...merged].sort(), failures };
}

export async function unsupportedDropMessage(
  port: IngestPort,
): Promise<string> {
  const formats = await port.listFormats();
  const extensions = formats.flatMap((format) =>
    format.extensions.map((extension) => `.${extension}`),
  );
  return `no supported files in the drop — supported: ${extensions.join(", ")}`;
}

function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}
```

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh unit drop`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/drop.ts frontend/src/app/drop.test.ts
git commit -m "feat(frontend): classify and expand dropped paths"
```

---

### Task 4: App-shell drop wiring — overlay, modal guard, routing

**Files:**

- Modify: `frontend/src/ui/app-shell.ts`, `frontend/src/styles/app.css`
- Test: `frontend/src/ui/app-shell.test.ts`

**Interfaces:**

- Consumes: `IngestPort.onDragDrop` (Task 2); `classifyDrop`,
  `expandDropPaths`, `unsupportedDropMessage` (Task 3); existing private
  members `this.plane`, `this.palette`, `this.exportDialog`,
  `this.loadSession(path)`, `this.ingestPaths(paths)`,
  `this.reportError(error)`, `required` from `./dom`.
- Produces: private `modalOpen(): boolean`, `onDragDrop(event): void`,
  `handleDrop(paths): Promise<void>`; a `.drop-overlay` element in
  `shellMarkup`. Nothing later consumes these; they are wiring.

- [ ] **Step 1: Write the failing test**

In `frontend/src/ui/app-shell.test.ts`, following the file's
`Object.create(AppShell.prototype)` probe idiom:

```ts
interface DropProbe {
  root: HTMLElement;
  plane: { ingest: unknown };
  palette: { isOpen(): boolean } | null;
  exportDialog: { isOpen(): boolean } | null;
  loadSession: ReturnType<typeof vi.fn>;
  ingestPaths: ReturnType<typeof vi.fn>;
  reportError: ReturnType<typeof vi.fn>;
  onDragDrop(event: { kind: string; paths: string[] }): void;
  handleDrop(paths: string[]): Promise<void>;
}

function dropProbe(ingest: unknown, modalOpen = false): DropProbe {
  const probe = Object.create(AppShell.prototype) as DropProbe;
  probe.root = document.createElement("div");
  probe.root.innerHTML = `<div class="drop-overlay" hidden></div>`;
  probe.plane = { ingest };
  probe.palette = { isOpen: () => modalOpen };
  probe.exportDialog = null;
  probe.loadSession = vi.fn(async () => undefined);
  probe.ingestPaths = vi.fn(async () => undefined);
  probe.reportError = vi.fn();
  return probe;
}

const scanIngest = (files: string[]) => ({
  scanSources: async () => ({
    files,
    total_bytes: "0",
    format_counts: [],
  }),
  listFormats: async () => [
    { id: "csv", label: "Delimited text", extensions: ["csv"] },
  ],
});

describe("drag-drop routing", () => {
  it("shows the overlay on enter and hides it on leave", () => {
    const probe = dropProbe(scanIngest([]));
    const overlay = probe.root.querySelector(".drop-overlay");
    probe.onDragDrop({ kind: "enter", paths: [] });
    expect(overlay?.hasAttribute("hidden")).toBe(false);
    probe.onDragDrop({ kind: "leave", paths: [] });
    expect(overlay?.hasAttribute("hidden")).toBe(true);
  });

  it("ignores drops and keeps the overlay hidden while a modal is open", () => {
    const probe = dropProbe(scanIngest(["/a.csv"]), true);
    probe.onDragDrop({ kind: "enter", paths: [] });
    expect(
      probe.root.querySelector(".drop-overlay")?.hasAttribute("hidden"),
    ).toBe(true);
    probe.onDragDrop({ kind: "drop", paths: ["/a.csv"] });
    expect(probe.ingestPaths).not.toHaveBeenCalled();
  });

  it("opens a dropped workspace file through loadSession", async () => {
    const probe = dropProbe(scanIngest([]));
    await probe.handleDrop(["/w/flight.signalscope"]);
    expect(probe.loadSession).toHaveBeenCalledWith("/w/flight.signalscope");
    expect(probe.ingestPaths).not.toHaveBeenCalled();
  });

  it("expands data drops into the batch ingest path", async () => {
    const probe = dropProbe(scanIngest(["/runs/a.csv", "/runs/b.csv"]));
    await probe.handleDrop(["/runs"]);
    expect(probe.ingestPaths).toHaveBeenCalledWith([
      "/runs/a.csv",
      "/runs/b.csv",
    ]);
  });

  it("rejects mixed drops and reports the reason", async () => {
    const probe = dropProbe(scanIngest([]));
    await probe.handleDrop(["/w/a.signalscope", "/d/a.csv"]);
    expect(probe.reportError).toHaveBeenCalled();
    expect(probe.loadSession).not.toHaveBeenCalled();
    expect(probe.ingestPaths).not.toHaveBeenCalled();
  });

  it("reports the supported formats when a drop expands to nothing", async () => {
    const probe = dropProbe(scanIngest([]));
    await probe.handleDrop(["/empty"]);
    expect(probe.ingestPaths).not.toHaveBeenCalled();
    const [error] = probe.reportError.mock.calls[0] ?? [];
    expect(String(error)).toContain(".csv");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh unit app-shell`
Expected: FAIL — `onDragDrop` / `handleDrop` missing, no `.drop-overlay`.

- [ ] **Step 3: Implement it**

In `app-shell.ts`, import `classifyDrop`, `expandDropPaths`, and
`unsupportedDropMessage` from `../app/drop` and `DragDropForward` from the
generated protocol. Add the private members:

```ts
  private dropUnsubscribe: (() => void) | null = null;

  private modalOpen(): boolean {
    return (
      this.palette?.isOpen() === true || this.exportDialog?.isOpen() === true
    );
  }

  private onDragDrop(event: DragDropForward): void {
    const overlay = required<HTMLElement>(this.root, ".drop-overlay");
    if (event.kind === "enter") {
      overlay.hidden = this.modalOpen();
      return;
    }
    overlay.hidden = true;
    if (event.kind === "leave" || this.modalOpen()) return;
    void this.handleDrop(event.paths);
  }

  private async handleDrop(paths: string[]): Promise<void> {
    const port = this.plane.ingest;
    if (port === null || paths.length === 0) return;
    const plan = classifyDrop(paths);
    if (plan.kind === "rejected") {
      this.reportError(new Error(plan.message));
      return;
    }
    if (plan.kind === "workspace") {
      await this.loadSession(plan.path);
      return;
    }
    try {
      const expansion = await expandDropPaths(port, plan.paths);
      for (const failed of expansion.failures) {
        this.reportError(new Error(`could not scan ${failed}`));
      }
      if (expansion.files.length === 0) {
        if (expansion.failures.length === 0) {
          this.reportError(new Error(await unsupportedDropMessage(port)));
        }
        return;
      }
      await this.ingestPaths(expansion.files);
    } catch (error: unknown) {
      this.reportError(error);
    }
  }
```

Subscribe in the initialization block that constructs the palette
(`app-shell.ts:511`), after `this.registerCommands()`:

```ts
    const dragPort = this.plane.ingest;
    if (dragPort !== null) {
      this.dropUnsubscribe = dragPort.onDragDrop((event) => {
        this.onDragDrop(event);
      });
    }
```

In `shellMarkup`, add as the last child of the shell root markup:

```html
      <div class="drop-overlay" hidden>Drop files or a folder to load</div>
```

In `app.css`, near the other overlay styles:

```css
.drop-overlay {
  position: fixed;
  inset: 12px;
  z-index: 40;
  display: grid;
  place-items: center;
  border: 2px dashed var(--accent, #d9a441);
  border-radius: 8px;
  background: color-mix(in srgb, var(--bg, #14161a) 78%, transparent);
  font-size: 1.1rem;
  pointer-events: none;
}
```

(`pointer-events: none` matters: the overlay must never swallow the native
drop, which the Tauri window handles.)

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh unit app-shell` then `./scripts/test.sh frontend`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src
git commit -m "feat(ui): route window drops into ingest and workspace open"
```

---

### Task 5: Direct open, folder command, chooser modal deleted

**Files:**

- Modify: `frontend/src/ui/app-shell.ts` (`openSources` at :1623, the
  `open-sources` command registration in `registerCommands`, the
  `SourceOpenDialog` import at :85 and field at :173)
- Delete: `frontend/src/ui/source-open-dialog.ts`,
  `frontend/src/ui/source-open-dialog.test.ts`
- Modify: `frontend/src/styles/app.css` (delete the `.source-open-*` rules,
  app.css:2147–2196)
- Test: `frontend/src/ui/app-shell.test.ts`

**Interfaces:**

- Consumes: `pickIngestPaths(port, kind)` and `SourceOpenKind` from
  `../app/ingest` (existing, unchanged); `this.pickAndIngest(kind)` (existing
  private, app-shell.ts:1631).
- Produces: `openSources()` invokes the file picker directly; new private
  `openFolder(): void`; palette/menu command `open-folder` titled
  `Open folder…` in section `file`, group `open`, with no key binding.

- [ ] **Step 1: Write the failing test**

In `frontend/src/ui/app-shell.test.ts`:

```ts
describe("direct open", () => {
  interface OpenProbe {
    plane: { ingest: unknown };
    pickAndIngest: ReturnType<typeof vi.fn>;
    openSources(): void;
    openFolder(): void;
  }

  function openProbe(): OpenProbe {
    const probe = Object.create(AppShell.prototype) as OpenProbe;
    probe.plane = { ingest: {} };
    probe.pickAndIngest = vi.fn(async () => undefined);
    return probe;
  }

  it("opens the native file picker with no intermediate chooser", () => {
    const probe = openProbe();
    probe.openSources();
    expect(probe.pickAndIngest).toHaveBeenCalledWith("files");
  });

  it("opens the folder picker from the demoted command", () => {
    const probe = openProbe();
    probe.openFolder();
    expect(probe.pickAndIngest).toHaveBeenCalledWith("folder");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh unit app-shell`
Expected: FAIL — `openSources` still constructs the dialog; `openFolder`
missing.

- [ ] **Step 3: Implement it**

Replace `openSources` (app-shell.ts:1623-1629) and add `openFolder`:

```ts
  private openSources(): void {
    if (this.plane.ingest === null) return;
    void this.pickAndIngest("files");
  }

  private openFolder(): void {
    if (this.plane.ingest === null) return;
    void this.pickAndIngest("folder");
  }
```

Register the folder command immediately after the `open-sources` registration
in `registerCommands` (the `open-sources` entry itself is unchanged — its
`run` already calls `this.openSources()`):

```ts
    this.commands.register({
      id: "open-folder",
      title: "Open folder…",
      section: "file",
      group: "open",
      enabled: () => this.plane.ingest !== null,
      run: () => {
        this.openFolder();
      },
    });
```

Delete: the `SourceOpenDialog` import (app-shell.ts:85), the
`sourceOpenDialog` field (app-shell.ts:173), both source-open-dialog files,
and the `.source-open-*` CSS block (app.css:2147–2196). If `SourceOpenKind`
is now imported only for `pickAndIngest`'s parameter type, keep it — it still
types the two call sites.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh unit app-shell` then `./scripts/test.sh frontend`
Expected: PASS, including lint/knip with the deleted files gone.

- [ ] **Step 5: Commit**

```bash
git add -A frontend/src
git commit -m "refactor(ui): open the file picker directly and demote folder open"
```

---

### Task 6: ADR, gate, and version bump

**Files:**

- Create: `docs/adr/0032-drag-drop-event-forwarding.md`
- Modify: `docs/adr/README.md`

- [ ] **Step 1: Write ADR 0032**

Record: the protocol gains its first push-style surface — window drag-drop
forwarded as `Envelope<DragDropForward>` on `scope://drag-drop`, typed in
`scope-protocol.json` and consumed through the raw internals event plugin
because the frontend's zero-runtime-dependency policy forbids
`@tauri-apps/api`; `Over` events are never forwarded (pointer-move
frequency); the snapshot host has no event source, so snapshots stay inert;
drop classification treats `.signalscope`/`.json` as workspace files and
everything else as data expanded through `scan_sources`. Add the row to
`docs/adr/README.md`.

- [ ] **Step 2: Run the gate**

```bash
./scripts/format.sh
./scripts/ci.sh all
```

Expected: PASS, including `pnpm codegen:check` and `check:deps`.

- [ ] **Step 3: Bump and commit**

```bash
./scripts/version.sh bump minor   # new capability, additive protocol type
./scripts/version.sh check
git add docs Cargo.toml Cargo.lock package.json frontend/package.json shell/src-tauri
git commit -m "docs: record the drag-drop event forwarding decision"
```

---

## Self-Review

**Spec coverage.** Direct open from all entry points → Task 5 (`open-sources`
command, dock footer, and `+ source` all call `openSources()`, whose body now
goes straight to the file picker; `O` binding untouched). Demoted
`Open folder…` in menu and palette only → Task 5 (registered without `keys`;
`AppMenu` and the palette both render from `CommandRegistry`). Chooser modal
deleted → Task 5. Drag-drop through the ingest port with the snapshot host
inert → Tasks 1–2 (emission is native-only; `BakedPlane.ingest` stays null
and the subscription is guarded). Overlay while hovering, drops ignored while
a modal is open → Task 4. Classification rules, mixed/multiple-workspace
rejection, per-path failure tolerance, zero-supported-files message naming
formats → Tasks 3–4. Cancelled dialogs and rejected drops leave the
workspace unchanged → no state is touched before `loadSession`/`ingestPaths`
in any path.

**Placeholder scan.** Every step carries concrete code or an exact command;
no TBDs; error handling is written out in Tasks 3–4, not deferred.

**Type consistency.** `DragDropForward { kind: DragDropKind, paths: string[] }`
is defined in Task 1 and consumed by name in Tasks 2 and 4;
`onDragDrop(handler) => unsubscribe` matches between Task 2's port and Task
4's subscription; `DropPlan`/`DropExpansion`/`unsupportedDropMessage` match
between Tasks 3 and 4; `TauriPlane`'s two-argument constructor is used in
Task 2's tests; `ScanSourcesResponse.total_bytes` is a string in test fakes
(wire `u64`), consistent with the codebase's u64-as-string rule.
