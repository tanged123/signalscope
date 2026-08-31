import { describe, expect, it } from "vitest";

import type { Session, SourceRecord } from "../generated/session";
import { emptySession } from "./workspace";
import {
  HistoryStack,
  historySnapshot,
  restoreTransientSessionState,
} from "./history";

function sessionWithTheme(theme: Session["theme"]): Session {
  return { ...emptySession(), theme };
}

function sessionWithWindow(t1: number): Session {
  const session = emptySession();
  session.linked_time.t1 = t1;
  return session;
}

describe("HistoryStack", () => {
  it("undoes and redoes committed states", () => {
    const stack = new HistoryStack();
    stack.reset(sessionWithTheme("dark"));
    stack.commit(sessionWithTheme("light"));
    expect(stack.canUndo()).toBe(true);
    expect(stack.undo()?.theme).toBe("dark");
    expect(stack.canUndo()).toBe(false);
    expect(stack.redo()?.theme).toBe("light");
    expect(stack.canRedo()).toBe(false);
  });

  it("returns null at the ends of history", () => {
    const stack = new HistoryStack();
    stack.reset(emptySession());
    expect(stack.undo()).toBeNull();
    expect(stack.redo()).toBeNull();
  });

  it("skips commits that do not change state", () => {
    const stack = new HistoryStack();
    stack.reset(emptySession());
    stack.commit(emptySession());
    expect(stack.canUndo()).toBe(false);
  });

  it("coalesces consecutive commits sharing a key", () => {
    const stack = new HistoryStack();
    stack.reset(sessionWithWindow(60));
    stack.commit(sessionWithWindow(50), "window:panel-1");
    stack.commit(sessionWithWindow(40), "window:panel-1");
    stack.commit(sessionWithWindow(30), "window:panel-1");
    expect(stack.undo()?.linked_time.t1).toBe(60);
  });

  it("breaks a coalescing run when the key changes", () => {
    const stack = new HistoryStack();
    stack.reset(sessionWithWindow(60));
    stack.commit(sessionWithWindow(50), "window:panel-1");
    stack.commit(sessionWithTheme("light"));
    stack.commit(sessionWithWindow(40), "window:panel-1");
    expect(stack.undo()?.theme).toBe("light");
  });

  it("closes a coalescing run on an unchanged unkeyed commit", () => {
    const stack = new HistoryStack();
    stack.reset(sessionWithWindow(60));
    stack.commit(sessionWithWindow(50), "range:panel-1");
    stack.commit(sessionWithWindow(50));
    stack.commit(sessionWithWindow(40), "range:panel-1");
    expect(stack.undo()?.linked_time.t1).toBe(50);
  });

  it("clears the redo branch on a new commit", () => {
    const stack = new HistoryStack();
    stack.reset(sessionWithWindow(60));
    stack.commit(sessionWithWindow(50));
    stack.undo();
    stack.commit(sessionWithTheme("light"));
    expect(stack.canRedo()).toBe(false);
  });

  it("caps stored history at 100 entries", () => {
    const stack = new HistoryStack();
    stack.reset(sessionWithWindow(1));
    for (let step = 2; step <= 150; step += 1) {
      stack.commit(sessionWithWindow(step));
    }
    let undos = 0;
    while (stack.undo() !== null) undos += 1;
    expect(undos).toBe(100);
  });

  it("hands out clones, not shared references", () => {
    const stack = new HistoryStack();
    stack.reset(sessionWithTheme("dark"));
    stack.commit(sessionWithTheme("light"));
    const restored = stack.undo();
    if (restored === null) throw new Error("expected a session");
    restored.theme = "light";
    expect(stack.redo()?.theme).toBe("light");
    expect(stack.undo()?.theme).toBe("dark");
  });
});

describe("history session projection", () => {
  const source: SourceRecord = {
    key: "00000000-0000-0000-0000-000000000001",
    path: "/data/run.csv",
    prefix: "run",
    provider_id: null,
    decode_provenance: null,
    recipe_id: null,
    recipe_digest: null,
  };

  it("excludes cursor, focus, and ingested sources", () => {
    const session = emptySession();
    const tab = session.tabs[0];
    if (tab === undefined) throw new Error("expected a workspace tab");
    session.linked_time.cursorT = 12;
    session.sources = [source];
    tab.focused_panel_id = "panel-1";

    const snapshot = historySnapshot(session);

    expect(snapshot.linked_time.cursorT).toBeNull();
    expect(snapshot.sources).toEqual([]);
    expect(snapshot.tabs[0]?.focused_panel_id).toBeNull();
  });

  it("keeps named sets in undo snapshots", () => {
    const session = emptySession();
    session.named_sets = [
      {
        id: "set-1",
        name: "Saved",
        kind: "pick",
        selector: null,
        refs: [{ source_key: "run-1", channel: "temp" }],
      },
    ];

    expect(historySnapshot(session).named_sets).toEqual(session.named_sets);
  });

  it("preserves live transient state when applying history", () => {
    const historical = emptySession();
    const current = structuredClone(historical);
    const historicalTab = historical.tabs[0];
    const currentTab = current.tabs[0];
    if (historicalTab === undefined || currentTab === undefined) {
      throw new Error("expected a workspace tab");
    }
    historicalTab.focused_panel_id = null;
    currentTab.focused_panel_id = currentTab.panels[0]?.id ?? null;
    current.linked_time.cursorT = 8;
    current.sources = [source];
    historical.named_sets = [
      {
        id: "historical",
        name: "Historical",
        kind: "query",
        selector: "temp",
        refs: [],
      },
    ];
    current.named_sets = [
      {
        id: "current",
        name: "Current",
        kind: "pick",
        selector: null,
        refs: [],
      },
    ];

    const restored = restoreTransientSessionState(historical, current);

    expect(restored.linked_time.cursorT).toBe(8);
    expect(restored.sources).toEqual([source]);
    expect(restored.named_sets).toEqual(historical.named_sets);
    expect(restored.tabs[0]?.focused_panel_id).toBe(
      currentTab.focused_panel_id,
    );
  });
});
