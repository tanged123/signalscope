// Writes the hosted demo's Monte Carlo corpus and workspace under
// build/demo-corpus/.
// Output is deterministic and never committed: ./scripts/demo.sh bakes it.
//
// Each run is a point-mass suborbital launch and entry with dispersed thrust,
// specific impulse, dry mass, drag and wind. Values are rounded to float32,
// as flight telemetry typically is, and stored exactly by the snapshot.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const corpusDir = resolve(root, "build", "demo-corpus");

const RUNS = 1_000;
const SAMPLE_DT = 2;
const SAMPLES = 321;
const SUBSTEPS = 10;
const G0 = 9.80665;
const CHANNELS = [
  "altitude",
  "velocity",
  "downrange",
  "crossrange",
  "dynamic_pressure",
];

function generator(seed) {
  let state = seed >>> 0;
  const uniform = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => {
    const u = Math.max(uniform(), Number.EPSILON);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * uniform());
  };
}

const density = (h) => 1.225 * Math.exp(-h / 8_500);
/** Wind fades linearly to zero at 15 km. */
const wind = (h) => (h < 15_000 ? 1 - h / 15_000 : 0);

function simulate(run) {
  const gauss = generator(run * 7919 + 17);
  const thrust = 330_000 * (1 + 0.03 * gauss());
  const isp = 262 * (1 + 0.015 * gauss());
  const dryMass = 9_000 * (1 + 0.02 * gauss());
  const drag = 1 + 0.08 * gauss();
  const ascentArea = 0.42 * drag;
  const entryArea = 5 * drag;
  const chuteArea = 800 * (1 + 0.05 * gauss());
  const kick = (2.2 + 0.25 * gauss()) * (Math.PI / 180);
  const windDown = 6 * gauss();
  const windCross = 9 * gauss();
  const heading = 0.004 * gauss();

  let propellant = 11_000;
  let x = 0;
  let y = 0;
  let h = 0;
  let vx = 0;
  let vy = 0;
  let vh = 0;
  let landed = false;
  const dt = SAMPLE_DT / SUBSTEPS;
  const rows = [];
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    const time = sample * SAMPLE_DT;
    const air = Math.hypot(
      vx - windDown * wind(h),
      vy - windCross * wind(h),
      vh,
    );
    const q = landed ? 0 : 0.5 * density(h) * air * air;
    rows.push([time, h, Math.hypot(vx, vy, vh), x, y, q]);
    if (landed) continue;
    for (let step = 0; step < SUBSTEPS; step += 1) {
      const t = time + step * dt;
      const mass = dryMass + propellant;
      let tx = 0;
      let ty = 0;
      let th = 0;
      if (propellant > 0) {
        // Vertical rise, a small pitch kick, then a gravity turn along velocity.
        if (t < 12) {
          const angle = Math.PI / 2 - kick * Math.max(0, (t - 6) / 6);
          tx = Math.cos(angle) * Math.cos(heading);
          ty = Math.cos(angle) * Math.sin(heading);
          th = Math.sin(angle);
        } else {
          const speed = Math.hypot(vx, vy, vh);
          tx = vx / speed;
          ty = vy / speed;
          th = vh / speed;
        }
        propellant = Math.max(0, propellant - (thrust / (isp * G0)) * dt);
      }
      const force = propellant > 0 ? thrust / mass : 0;
      const rx = vx - windDown * wind(h);
      const ry = vy - windCross * wind(h);
      // Cd·A: slender on ascent, blunt after burnout, then a main parachute.
      const area =
        propellant > 0
          ? ascentArea
          : h < 2_500 && vh < 0
            ? chuteArea
            : entryArea;
      const k = (0.5 * density(h) * Math.hypot(rx, ry, vh) * area) / mass;
      vx += (force * tx - k * rx) * dt;
      vy += (force * ty - k * ry) * dt;
      vh += (force * th - k * vh - G0) * dt;
      x += vx * dt;
      y += vy * dt;
      h += vh * dt;
      if (h <= 0 && t > 5) {
        h = 0;
        vx = 0;
        vy = 0;
        vh = 0;
        landed = true;
        break;
      }
    }
  }
  return rows;
}

function csv(rows) {
  const lines = [`time,${CHANNELS.join(",")}`];
  for (const [time, ...values] of rows) {
    lines.push(
      [String(time), ...values.map((value) => String(Math.fround(value)))].join(
        ",",
      ),
    );
  }
  return `${lines.join("\n")}\n`;
}

const runName = (run) => `run_${String(run).padStart(4, "0")}`;
const runKey = (run) =>
  `00000000-0000-4000-8000-${run.toString(16).padStart(12, "0")}`;
const FLIGHT_KEY = "00000000-0000-4000-8000-f11900000000";
const END = (SAMPLES - 1) * SAMPLE_DT;

function panel(id, title, content, fields) {
  return {
    id,
    title,
    content,
    content_selection_pending: false,
    axis_style: "inline",
    axis_equal: false,
    x_scale: null,
    y_scale: null,
    x_reversed: null,
    y_reversed: null,
    bindings: [],
    color_by: "source",
    dash_by: null,
    width_by: null,
    line_width: 1,
    ghost_opacity: 0.5,
    overrides: [],
    focus: [],
    ghost_mode: "all",
    legend_state: "badge",
    legend_position: null,
    legend_size: null,
    legend_anchor: null,
    legend_dock: null,
    legend_hint_dismissed: true,
    x_axis: { kind: "time" },
    color_axis: null,
    y_range: null,
    x_range: null,
    x_label: null,
    y_label: null,
    time_window: [0, END],
    annotations: [],
    annotation_display: "labels",
    show_stats: false,
    stat_columns: ["min", "max", "mean", "rms", "cursor"],
    stats_sort: null,
    stats_sort_descending: false,
    ...fields,
  };
}

const query = (selector) => [
  { kind: "query", selector, refs: [], set_id: null },
];
const bundle = (channel) => ({
  kind: "bundle",
  refs: Array.from({ length: RUNS }, (_, index) => ({
    source_key: runKey(index + 1),
    channel,
  })),
});
const row = (height, ids) => ({
  height,
  panels: ids.map((panel_id) => ({ panel_id, width: 1 / ids.length })),
});

function workspace(flightPath) {
  const line = { kind: "line2d" };
  const runs = "@run_*";
  const mc = [
    panel("mc-altitude", "Altitude", line, {
      bindings: query(`altitude ${runs}`),
      y_label: "altitude (m)",
    }),
    panel("mc-velocity", "Velocity", line, {
      bindings: query(`velocity ${runs}`),
      y_label: "speed (m/s)",
    }),
    panel("mc-ground-track", "Ground track", line, {
      bindings: query(`crossrange ${runs}`),
      x_axis: bundle("downrange"),
      x_label: "downrange (m)",
      y_label: "crossrange (m)",
    }),
    panel(
      "mc-profile",
      "Trajectory colored by dynamic pressure",
      {
        kind: "scatter2d",
      },
      {
        bindings: query(`altitude ${runs}`),
        x_axis: bundle("downrange"),
        color_axis: {
          source: bundle("dynamic_pressure"),
          scale: null,
          range: null,
          label: "dynamic pressure (Pa)",
        },
        x_label: "downrange (m)",
        y_label: "altitude (m)",
      },
    ),
    panel("mc-q", "Dynamic pressure", line, {
      bindings: query(`dynamic_pressure ${runs}`),
      y_label: "q (Pa)",
    }),
    panel("mc-crossrange", "Crossrange drift", line, {
      bindings: query(`crossrange ${runs}`),
      y_label: "crossrange (m)",
    }),
  ];
  const flightPanel = (id, title, selector) =>
    panel(id, title, line, {
      bindings: query(`${selector} @demo_flight`),
      color_by: "channel",
      line_width: 2,
      legend_state: "keys",
      time_window: [0, 20],
    });
  const flight = [
    flightPanel(
      "flight-altitude",
      "Altitude",
      "altitude_m|sensor/gps_altitude_m",
    ),
    flightPanel("flight-velocity", "Body velocity", "velocity_body/*"),
    flightPanel("flight-attitude", "Attitude", "attitude/*"),
    flightPanel("flight-control", "Throttle and mode", "control/*|flight/*"),
  ];
  return {
    app: "signalscope",
    title: "Suborbital dispersion demo",
    schema_version: 34,
    theme: "dark",
    linked_time: {
      t0: 0,
      t1: END,
      linked: false,
      paused: false,
      cursorT: null,
      mode: "fixed",
    },
    active_tab_id: "monte-carlo",
    tabs: [
      {
        id: "monte-carlo",
        title: `Monte Carlo · ${RUNS.toLocaleString("en-US")} runs`,
        cursor_mode: "none",
        focused_panel_id: null,
        maximized_panel_id: null,
        panels: mc,
        layout: [
          row(1 / 3, ["mc-altitude", "mc-velocity"]),
          row(1 / 3, ["mc-ground-track", "mc-profile"]),
          row(1 / 3, ["mc-q", "mc-crossrange"]),
        ],
      },
      {
        id: "single-flight",
        title: "Single flight",
        cursor_mode: "none",
        focused_panel_id: null,
        maximized_panel_id: null,
        panels: flight,
        layout: [
          row(0.5, ["flight-altitude", "flight-velocity"]),
          row(0.5, ["flight-attitude", "flight-control"]),
        ],
      },
    ],
    named_sets: [],
    derived: [],
    derived_bundles: [],
    sources: [
      ...Array.from({ length: RUNS }, (_, index) => ({
        key: runKey(index + 1),
        path: relative(root, resolve(corpusDir, `${runName(index + 1)}.csv`)),
        prefix: runName(index + 1),
      })),
      { key: FLIGHT_KEY, path: flightPath, prefix: "demo_flight" },
    ],
  };
}

await rm(corpusDir, { recursive: true, force: true });
await mkdir(corpusDir, { recursive: true });
for (let run = 1; run <= RUNS; run += 1) {
  await writeFile(
    resolve(corpusDir, `${runName(run)}.csv`),
    csv(simulate(run)),
  );
}
await writeFile(
  resolve(corpusDir, "dispersion.workspace.json"),
  `${JSON.stringify(workspace("examples/demo_flight.csv"), null, 2)}\n`,
);
