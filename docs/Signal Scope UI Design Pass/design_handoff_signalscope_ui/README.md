# Handoff: SignalScope UI — Final Design Package

## Overview
SignalScope is an internal time-series analysis workbench for engineering telemetry (vehicle logs, test-stand data, firmware traces, monte-carlo batches). This package is the FINAL design specification. Product pillars: (1) MATLAB — the plot is an inspectable, annotatable object; (2) Plotly — any session exports as one self-contained interactive HTML file; (3) uPlot — millions of points at interactive framerates, no chrome may assume small data; (4) PlotJuggler — one workspace, one linked time spine.

## About the Design Files
The files here are **design references created in HTML** — mockups of intended look and behavior, not production code. Recreate them in the SignalScope codebase (keep the prototype's proven canvas min/max decimation renderer and interaction engine in `reference/signalscope.html`).

## Fidelity
- **Pixel reference:** `SignalScope Final Spec.dc.html` → **F2** (canonical 2×2 workspace, 1440px, gutter axes). Recreate chrome, spacing, hierarchy precisely.
- **Directional:** F1 (IA wireframe), F3 (stacked layout, inline axes, ⌘K open), F5 (legend), F6·1–5 (empty states, export dialog, annotations, XY drop strip, build order).

## Visual System (final)
- **Ground — near-black.** App background `--surface-void #07090C`; panels + signal tree `--surface-0 #0E1116`; menu/toolbar/status/panel-header bars `--surface-1/2`. Flat surfaces, 1px `--border` seams (no floating cards), radii ≤4px, no glows/gradients.
- **Chrome is fully achromatic** — grays only. Active toggles, mode pills, selections: `--surface-4` fill + `--fg-1` text. NEVER amber fills for chrome state.
- **Amber (`--amber-7 #FFA226`) is interaction-only:** synced cursor, focused-panel 1px inset (`rgba(255,162,38,.5)`), Δ readouts, pinned MC run, ƒx/derived marks, drag-drop targets, XY cursor marker.
- **Type:** Inter (UI); JetBrains Mono + `tabular-nums` for every number, signal path, readout, axis label. Base 13px, chrome 10–11.5px, axis 9–9.5px. Values %.4f; units as separate dimmed tokens. Signal paths lowercase snake_case, always mono.
- **Series palette:** `--series-1…8` categorical; dash classes beyond 8; identity never by color alone. Colorblind validation pending — fallback to prototype's PAL. Status colors reserved, never for series.
- **Light theme (see LIGHT section / L1 in the spec):** a pure token swap, toggled with T, flag serialized in sessions/snapshots (both palettes embedded). Ground #E3E6EB / panels #F7F8FA / bars #EFF1F4-#E7EAEE / active #C9CFD8; ink #1A1E26→#A7AEBB; grid #E4E7EC; borders #C9CFD8/#AEB6C2; amber accent darkens to #C17500 (focus inset rgba(193,117,0,.55)); series use the prototype's validated light palette (#2A78D6 #EB6834 #1BAF7A #EDA100 #E87BA4 #008300 #4A3AA7 #E34948); status connected #007A3D, error #C42B2B; shadows rgba(30,40,60,.15-.22); overlay rgba(240,242,245,.88). Implement as a token swap only — never per-component light styles.
- Motion: 80/140/240ms, cubic-bezier(0.2,0.8,0.2,1), no bounce/scale. Hover = surface one step up.

## Structure (final)
App shell rows: menu bar 28px · toolbar 34px · [tree 262px | panel grid] · formula bar 30px (grid column only, collapsible) · status bar 24px.
- **One workspace.** No tabs. Named layout presets (grid + modes + signals) in a toolbar dropdown, serialized in exports.
- **Signal tree:** search-first (`/`), ★ favorites with live values, virtualized tree (10k+ signals), live value at cursor per plotted leaf (4 decimals), `derived/` group with amber ƒx marks, sources footer (status dot + pt counts).
- **Panel:** 26px header = drag handle ⠿ · editable title · mode pills T·XY·FFT·H (always visible; active = surface-4+fg-1) · legend chips · dashed `x:` / `c:` chips (XY) · ⊞ ⤢ ✕. Focus = amber inset. Resize via seam handles; rearrange via header drag. Optional stats strip: per-series min/max/μ/rms of visible region.
- **Status bar:** connection + source count · total pts · render ms · cursor t · gesture hint strip · ⌘K. Reserved disabled `⏸ FOLLOW` slot in toolbar for future streaming.

## Axes (final — see F2, F3, and F6 cards)
- **Every plot owns complete axes.** Spine (left+bottom, `--fg-3` 1px), outward 4px ticks, numeric tick labels (mono 9px `--fg-3`), and a full axis NAME with unit on both x and y ("time (s)", "velocity (m/s)"; mono 9.5px `--fg-2`, editable in place). No naked plots. No shared/implied axes across panels — every panel self-describing.
- **Axis style per panel:** `axes: gutter · inline`. Gutter (default): left 52px / bottom 34px gutters, zero-line `--border-strong`. Inline: tick labels ON gridlines inside the plot with translucent `surface-0` ~80% backing; full axis names as corner tags (top-left = y, bottom-right = x). Identical information both ways; flag serializes into sessions/snapshots.
- **Color is an axis:** `c:` chip assigns a color channel (e.g. trajectory colored by time); a labeled colorbar with own ticks + name + unit is then mandatory (right edge, 12px, gutter 64px). Colormap perceptually uniform + colorblind-safe (viridis-class), separate from the categorical series palette.
- **3D (v2):** same anatomy — three labeled spines + tick sets, optional colorbar as fourth axis. Never a decorated cube.

## Interactions (keep from prototype, unchanged)
drag = box zoom · wheel = t zoom at cursor · shift+wheel = y zoom · right/middle-drag = pan · double-click = fit · click near line = pin datatip · double-click title/labels = edit. Drag signal → panel plots; drop on empty = new panel; drop on bottom strip (appears only during drag, amber) = use as X → panel flips to XY. Linked time: one window, synced cursor everywhere; XY trajectories filtered by window (dim gray outside, lit inside). Keys: L link · S stats · E formula · N row · O open · / filter · ? help · ⌘K palette.
Datatips = numbered annotations (①②…) with optional text label, per-panel list, dashed Δ connector + amber Δt/Δv/slope readout between two pins on a series; all serialized into exports.
Transforms: docked formula bar — `derived/name = expr`, quoted full-path references (`'source/group/signal'`), `gradient`/`cumtrapz`/`movmean`, MATLAB operators and scalar functions including `rad2deg`/`deg2rad`; ↵ create, ↑/↓ history, ctrl+space complete, esc collapse. Drag tree signals into the bar to insert references. Quick transforms are duplicated in the legend inspector.
Legend (F5): click chip = toggle (hidden = struck-through, dim swatch); hover = emphasize (others dim to 35%); ▾/right-click = inspector popover (8 color slots, solid/dash/dot + width, smooth/deriv, use-as-X, remove). Right-click is never the only path.
Many series: folder → one hue family or min–max envelope band (hue at 10%) + gray members; hover isolates, click pins (amber). Never >8 saturated lines.
Export dialog (F6·2): radio rows with live size estimates; snapshot embed choice (visible window vs all loaded) + budget bar; "decimated to ≤2k pts/px/series · annotations + zoom state included".
Empty states (F6·1): factual, no second person. ⌘K palette: one fuzzy surface over commands/signals/panels; `--surface-overlay` scrim is the app's only blur.

## State Management
Global: time window {t0,t1}, linked flag, cursor t, focused panel, layout presets. Per panel: mode, axis style, x-signal, c-signal, series[{path, colorSlot, dash, width, visible, emphasis}], y-range, annotations[{id, seriesPath, t, value, label}], stats flag. Session JSON = all above minus data; HTML snapshot = session + embedded decimated data.

## Assets
`ds/colors_and_type.css` + `ds/fonts/` (Inter, JetBrains Mono variable woff2) — token source of truth. No icon set: unicode glyphs in mono contexts (⠿ ▾ ⇄ Σ ƒx ✕ ⤢ ⊞); no emoji. Logo: 16px waveform polyline, `--amber-7`.

## Files
- `SignalScope Final Spec.dc.html` — THE final spec: F0 decisions, F1 IA wireframe, F2 pixel reference, F3 inline-axes/palette state, F5 legend, F6·1–5 key moments + build order.
- `SignalScope Design Pass.dc.html` — the exploration record (turns 1–5), for rationale only; where it disagrees with the Final Spec, the Final Spec wins.
- `ds/` — tokens + fonts. `reference/signalscope.html` — behavior source of truth. `reference/prompt.md` — original brief.
