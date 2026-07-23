# SignalScope — Design Pass Brief

## What this is

You are doing a formal design pass on **SignalScope**, an internal time-series analysis workbench for engineering telemetry (robotics/vehicle logs, test-stand data, firmware traces). A working single-file HTML prototype exists and has validated the core interaction ideas; your job is to take the concept from "engineer's prototype" to a coherent, opinionated product design.

Treat the prototype as evidence, not as the design. Keep what the prototype proved; redesign anything that exists only because it was easy to build.

## Product thesis

Every existing tool gets one thing right and the rest wrong. SignalScope's identity is the combination of four pillars, each borrowed from the tool that does it best:

1. **MATLAB — scientific manipulation and familiarity.** Direct manipulation of the figure itself: click-to-edit titles and axis labels, datatips pinned to real samples, deltas between cursors (togglable), per-series styling, visible-region statistics (min/max/mean/rms), derived signals from math expressions (`deriv`, `integ`, `smooth`, arbitrary per-sample expressions). Also not just 2d plot windows, but 3d, geo plots, FFTs, histograms, i.e flexible user defined plots as well. The feel to preserve: *the plot is an object you inspect and annotate, not a picture. You can specify many types of plots as well*  
     
2. **Plotly HTML — portability.** Any session exports as a single self-contained HTML file with data, layout, zoom state, and annotations embedded. The recipient opens it in a browser and gets the full interactive tool, not a screenshot. Sharing analysis \= sending one file (or one URL). No install, no license, no versioned viewer. The tool itself can export these HTMLs (given limitations of HTML, tool itself should be self contained with HTML as an export option that replicates its primary usability / functionality)  
     
3. **uPlot / LightningChart — speed.** Millions of points must pan and zoom at interactive framerates. The prototype does canvas rendering with per-pixel min/max decimation (\~30–60 ms full redraw of 800k points). Design must never introduce chrome or interaction patterns that assume small data.   
     
4. **PlotJuggler — centralization and workflow.** One workspace: a searchable hierarchical signal tree, drag-any-signal-onto-any-panel, splittable panel grid, linked time axes with a synchronized cursor across every panel, and XY (signal-vs-signal) plots that stay coupled to the time window. Centralized user UI that allows someone to import massive amounts of data, livestream realtime data like plot juggler, control types of plots shown, derive data, etc. 

## What the prototype already established (keep these behaviors)

- Signal tree sidebar (hierarchy from `/`\-separated names), search filter, drag-to-panel, drop-on-empty-space-creates-panel.  
- Linked time: one global time window; every time panel shares it; a hover in any panel draws a synced cursor in all panels.  
- XY mode per panel: any signal as x-axis, others resampled onto its timebase; the linked time window *filters* the visible trajectory; the synced cursor becomes a marker gliding along the curve, bidirectionally (hovering the trajectory drives the time cursor everywhere).  
- Interactions (desktop): drag \= box zoom, wheel \= time zoom, shift+wheel \= y zoom, right-drag \= pan, double-click \= fit, click \= pin datatip, two datatips \= Δt/Δy(/Δx) readout.  
- Interactions (touch): one-finger drag \= pan, pinch \= axis-aware zoom (horizontal pinch → time, vertical → y; solves finger-anchored ranges, so pan+zoom is one gesture), tap \= value readout, long-press \= pin datatip, double-tap \= fit. Sidebar becomes a drawer; tap-to-plot replaces drag. **(optional mobile support, deprioritize for now)**   
- Data in: CSV drag-drop (delimiter/header/time-column autodetect). Should be flexible to support future types of data / modes of streaming data. Data out: standalone HTML snapshot, session JSON, per-panel PNG, visible-region CSV. Things needed to be more useful than just a single picture png.  
- Derived signals live in the tree under `derived/` like any other signal.  
- Light/dark theming with a colorblind-validated 8-slot categorical palette (series identity always carried by legend labels, never color alone). Consider how many lines in monte-carlo (i.e families of grouped signals) should show?

## Known weaknesses of the prototype (design opportunities)

- **Discoverability is poor.** Nearly everything is a hidden gesture or a right-click. A new user cannot find XY mode, derived signals, or datatips without reading the help table. Design an affordance layer that doesn't tax experts.  
- **Panel management is crude.** Split-right/split-down with equal flex sizing; no drag-to-rearrange, no resize handles, no saved layouts/workspaces.  
- **The legend does too many jobs** (toggle, style, transform, remove, x-axis assignment) through one chip \+ context menu.  
- **Series \> 8 fall back to dashed/dotted reuse of the 8 hues.** Works, but the demo trips over it immediately; design a deliberate many-series story (grouping? per-panel palettes? emphasis model?).  
- **Mobile is functional but secondary.** Stacked panels scroll awkwardly (plots capture all touch, so you scroll via headers). Decide mobile's actual role: full workbench, or a review/annotate companion for shared snapshots?  
- **No onboarding/empty states beyond a single line.**  
- **Export UX is a flat menu**; snapshot size (data embedding) is invisible to the user.

## Design principles to hold

- Density is a feature. This is an engineer's bench, not a dashboard product — favor information density and keyboard/gesture fluency over whitespace.  
- Time is the spine. Every feature must state its relationship to the global time window (participates, filters by it, or explicitly opts out).  
- Everything inspectable, everything annotatable, everything exportable.  
- One artifact: whatever the design adds must survive the "single portable HTML file" constraint (or explicitly justify a server dependency).  
- Familiarity beats novelty: when in doubt, do what MATLAB or PlotJuggler users already expect.

## Open design questions (want explicit answers)

1. Information architecture: is the panel grid the right primary surface, or should there be workspaces/tabs (e.g., "time view" / "XY view" / "report")?  
2. What is the affordance model for mode-switching a panel (time ↔ XY) and for assigning the x-signal? The drop-on-lower-strip pattern needs a visual language.  
3. Datatips/annotation: how do pinned points, deltas, and (future) text notes scale to a report-ready artifact?  
4. The transform/expression system: inline quick-transforms vs. a formula bar vs. a node/pipeline view? What do MATLAB users reach for first?  
5. Many-series identity: propose a system (grouping, folders → color families, hover-to-isolate, per-panel emphasis).  
6. Live streaming (planned): what changes in the layout/interaction model when the time window is moving? Follow-mode toggle, pause semantics, buffer UI.  
7. Future data sources (MCAP/rosbag, HDF5/parquet, live WebSocket): does the signal tree scale to 10k+ signals? Search-first tree? Favorites/pinned?  
8. Mobile posture: full tool vs. review companion — pick one and design it.

## Constraints

- Must remain deployable as a static file (optionally \+ a thin backend later for big files/streaming; do not assume one exists for v1).  
- Rendering is HTML canvas; no chart-library skinning to lean on.  
- Palette: 8 categorical slots per theme, colorblind-validated, light \+ dark; identity never by color alone. Status colors are reserved and never used for series.  
- Typeface: system sans; tabular numerals for readouts and ticks.  
- Target users: controls/test engineers who live in MATLAB and PlotJuggler; secondary audience: anyone opening a shared snapshot with zero context.

## Requested deliverables from this pass

1. An IA/layout proposal (annotated wireframes: desktop primary, mobile posture per your answer to Q8).  
2. Interaction spec for: panel lifecycle (create/split/rearrange/resize), XY-mode entry/exit, datatip \+ annotation flow, transform/expression entry.  
3. A discoverability layer proposal (first-run, empty states, affordances, command palette?) that stays out of experts' way.  
4. Visual system: panel chrome, legend redesign, many-series identity model, density/spacing tokens on top of the existing palette.  
5. A prioritized punch list: what in the current prototype should be kept as-is, reworked, or dropped.

## Reference material

- `signalscope.html` — the working prototype (open in any desktop browser; press "Demo data"; `?` shows the shortcut/gesture table).  
- Reference tools: MATLAB figure editor, PlotJuggler 3.x, Plotly HTML export, uPlot demos (for the performance bar), Foxglove Studio (adjacent art).

