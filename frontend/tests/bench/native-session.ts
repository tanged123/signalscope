import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  SESSION_SCHEMA_VERSION,
  type Session,
} from "../../src/generated/session";

export async function installBenchmarkSession(userData: string): Promise<void> {
  const session: Session = {
    app: "signalscope",
    schema_version: SESSION_SCHEMA_VERSION,
    theme: "dark",
    linked_time: {
      t0: 0,
      t1: 7.5,
      linked: true,
      paused: false,
      cursorT: null,
      mode: "fixed",
    },
    active_tab_id: "benchmark",
    tabs: [
      {
        id: "benchmark",
        title: "Benchmark",
        cursor_mode: "none",
        focused_panel_id: "benchmark-panel",
        maximized_panel_id: null,
        panels: [
          {
            id: "benchmark-panel",
            title: "Response",
            axis_style: "gutter",
            bindings: [
              {
                kind: "query",
                selector: "response @*",
                refs: [],
                set_id: null,
              },
            ],
            color_by: "source",
            overrides: [],
            focus: [],
            ghost_mode: "all",
            split_by: "none",
            y_range: null,
            x_label: "time (s)",
            y_label: "value",
            time_window: null,
            annotations: [],
            show_stats: false,
          },
        ],
        layout: [
          { height: 1, panels: [{ panel_id: "benchmark-panel", width: 1 }] },
        ],
      },
    ],
    named_sets: [],
    derived: [],
    derived_bundles: [],
    sources: [],
  };
  await mkdir(userData, { recursive: true });
  await writeFile(
    join(userData, "session.autosave.json"),
    `${JSON.stringify(session)}\n`,
    "utf8",
  );
}
