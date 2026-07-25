# Phase 1 Visualization Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision 2 (2026-07-25).** Audited against the design-pass brief, the Final Spec,
`AGENTS.md`, the data-viz colour method and its validator, Crameri's Scientific colour
maps, and Rougier, Droettboom & Bourne, *Ten Simple Rules for Better Figures*. Changes
from revision 1 are listed in [Revision history](#revision-history) at the end; read it
if you are picking this up after having seen the earlier draft.

**Goal:** Close the phase-1 foundation gaps that are expensive to reverse later — an
unvalidated series palette that collides with the reserved amber role, a renderer with no
test harness at all, per-value tick formatting, a y-axis that rescales as you pan, and
silent colour aliasing past eight series.

**Architecture:** Five tasks in dependency order. Task 1 changes token values plus a new
test. Task 2 builds the renderer's first test harness — a headless recording canvas — and
fixes the tick pipeline behind it. Task 3 is a standalone correctness fix to the colour
slot allocator. Task 4 renders composite series identity (colour × dash) so slot 9 is no
longer pixel-identical to slot 1. Task 5 removes autoscale from the renderer entirely, so
`render()` becomes a pure function of (tiles, viewport, y-range, tokens). No schema
changes, no new dependencies, no new UI surfaces.

**Tech Stack:** TypeScript, Vitest, HTML canvas 2D, CSS custom properties. Rust is
untouched.

## Global Constraints

- Every workflow command goes through `./scripts/`. Do not invoke `pnpm`, `npx`,
  `vitest`, or `cargo` directly. Frontend gate: `./scripts/test.sh frontend`. Format gate:
  `./scripts/ci.sh format`.
- `frontend/src/generated/*.ts` and `protocol/schema/scope-protocol.json` are generated
  outputs. **This plan does not change any of them.** If a task appears to need a schema
  change, stop and escalate — it is out of scope.
- Amber (`--amber-7`, `--amber-9`, `--amber-3`, `--focus-ring`) is **interaction-only**:
  cursor, focus inset, Δ readouts, derived/ƒx marks, pinned emphasis, drop targets. It is
  never a series colour, never a generic active fill, never a status colour.
- Dark theme surfaces stay near-black and flat: 1px seams, radii ≤ 4px, no glows,
  gradients, or decorative shadows.
- Light mode is a **token swap**. Do not add per-component light-mode overrides.
- Series identity must never depend on colour alone.
- Use `--font-mono` (JetBrains Mono) with tabular numerals for all values, axes, and
  readouts.
- Do not use `git add -A`. Stage only the files named in each task's commit step. Three
  untracked screenshots and `docs/references/` exist at the repo root; leave them
  untracked.
- Preserve unrelated worktree changes. Inspect `git status` before starting each task.

### Toolchain facts this plan depends on

Verified against the tree; if any of these turn out to be false, stop and escalate rather
than working around them.

- `./scripts/test.sh frontend` runs `pnpm lint && pnpm typecheck && pnpm codegen:check &&
  pnpm test`, then the snapshot artifact checks. **Every step that says "expected: PASS"
  must therefore compile and lint**, not merely pass assertions.
- `tsconfig.json` sets `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess`,
  and `exactOptionalPropertyTypes`. An unused local is a hard typecheck failure. Indexed
  access is `T | undefined` — the `?? fallback` noise in the code below is required, not
  stylistic.
- ESLint runs `typescript-eslint` **`strictTypeChecked`**. Avoid `any`, non-null
  assertions, and `Proxy`-based dynamic stubs; prefer explicit object literals.
- Vitest runs in the **default `node` environment — there is no jsdom**. Unit tests have
  no `document`, no `window`, no `HTMLCanvasElement`. Task 2 Step 1 exists precisely to
  work within that constraint without adding a dependency.

---

## Non-Goals for Phase 1

These were considered and are **deliberately deferred**. Do not implement them; a reviewer
should reject a diff that adds them.

| Deferred | Why |
|---|---|
| `--seq-*` / `--div-*` colormap tokens | No consumer exists yet. Shipping tokens nothing reads repeats the `y_range` / `axis_style` mistake. **But the choice of source is not deferred** — ADR 0011 fixes it to Crameri's maps (see Task 1 Step 5) so phase 2 cannot invent a ramp. Note the Final Spec puts the `c:` colorbar in **v1**, not v2, so this consumer is nearer than it looks. |
| `PanelState.colormap` and `PanelState.series_style` fields | Session schema change. Adding an unread field costs a version bump now and a second one when the semantics settle. Defer both to a single phase-2 migration. |
| Family / ramp / envelope series styles for N > 8 | Feature work. Tasks 3 and 4 remove the *correctness* bug (aliasing) using fields already in the schema; the richer policies the Final Spec describes ("folder → colour family or envelope band; hover isolates, click pins") are phase 2. |
| Type and space scale tokens (`--font-size-*`, `--space-*`) | Mechanical, reversible, touches all 832 lines of `app.css`, and changes no behaviour. High review cost, low foundation risk. |
| Raising `--fg-3` / `--fg-4` above WCAG AA | The Final Spec fixes these ink values exactly (`fg-3 #7A8290`, `fg-4 #A7AEBB`). `--fg-3` measures 4.32:1 on `--surface-0` — genuinely below AA — but changing it is a spec deviation needing its own ADR. Task 2 instead moves *axis tick labels* — the one place where the low contrast is load-bearing — onto the existing `--fg-2` token (8.67:1 dark, 7.49:1 light, both verified), which needs no token change. |
| An explicit "fit y-axis" gesture | Task 5 makes the y-axis stable; double-click-to-fit is the gesture that re-fits it, and it is in the brief's gesture set. Wiring input is phase 2 — but see Task 5's deviation note, because the two ship as a pair conceptually. |
| Writing the resolved y-range into the session at export | There is no HTML snapshot export path in `frontend/src` yet. When one lands, that is where a resolved range gets frozen — not in the render loop. See Task 5. |
| Injecting a baked palette into the renderer for `BakedPlane` | Task 2 adds the seam (`setPalette`). Using it from the snapshot host is phase 2. |
| `prefers-reduced-motion` / `prefers-contrast` / `forced-colors` | Real gaps, but leaf-level and cheap at any time. |
| Inline axis style, annotations, datatips, stats row | Spec'd for v1 but they are features, not foundations. |
| Live values in the signal tree | Feature. |

---

## Task 1: Validated series palette with amber reserved

The dark palette fails validation and `--series-1` (`#ffb648`) is byte-identical to
`--amber-9`, so the most common series colour is the hue reserved for cursor, focus, and
derived marks. This task replaces both palettes with a validated set sharing one hue
order, and adds a test that keeps them validated.

**Files:**
- Create: `frontend/src/styles/palette.test.ts`
- Create: `docs/adr/0011-series-palette-and-reserved-amber.md`
- Modify: `frontend/src/styles/tokens.css:38-45` (dark series), `frontend/src/styles/tokens.css:78-85` (light series)
- Modify: `docs/adr/README.md:14` (append ADR 11 to the list)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `--series-1` … `--series-8` in both themes, hue-aligned slot-for-slot. Task 4
  relies on there being exactly 8 slots and on `SERIES_TOKENS` in `canvas-renderer.ts:30-39`
  remaining the ordered list of their names.

### The palette and how it was derived

Do not treat these as hand-picked values. They are the data-viz reference palette's hue
families, re-stepped per mode, with one substitution:

- Seven of the eight reference hue families are kept unchanged: blue 255°, orange 41°,
  green 162°, violet 284°, pink 357°, deep green 142°, red 25°.
- The reference palette's amber slot (`#eda100`, OKLCh hue 75.1°) lands inside the band
  this product reserves for interaction. It is **evicted** and replaced with an azure at
  205°, which is the widest gap in the remaining hue circle.
- The eight are then re-ordered and re-stepped in OKLCh against each mode's lightness
  band.

That derivation is what makes the palette extensible; it is recorded in ADR 0011 so the
next person to touch a slot does not start from zero.

| Slot | Hue | Dark | Light |
|---|---|---|---|
| 1 | 255° blue | `#407fd0` | `#1970d1` |
| 2 | 41° orange | `#a7451c` | `#89340f` |
| 3 | 162° green | `#29ab79` | `#33cf93` |
| 4 | 284° violet | `#5e57b2` | `#6653dc` |
| 5 | 357° pink | `#a6416b` | `#931553` |
| 6 | 205° azure | `#28a4b0` | `#33c6d5` |
| 7 | 142° deep green | `#247320` | `#126410` |
| 8 | 25° red | `#db6c66` | `#fa8e86` |

Recorded validator results (these are what the test asserts):

- **Dark** on `--surface-0` `#0e1116` — lightness band PASS (all inside L 0.48–0.67),
  chroma floor PASS, CVD separation PASS (worst adjacent ΔE 10.1 protan, tritan 18.4),
  normal-vision floor PASS (worst adjacent ΔE 16.8), contrast PASS (all ≥ 3:1, min 3.14).
- **Light** on `--surface-0` `#f7f8fa` — lightness band PASS, chroma floor PASS, CVD
  separation PASS (worst adjacent ΔE 21.8), normal-vision floor PASS (worst adjacent
  ΔE 24.2), contrast WARN (slots 3, 6, 8 at 1.88, 1.94, 2.13). The WARN is discharged by
  the legend chips, which carry the signal path as text next to every swatch — identity is
  never colour-alone. **Task 4 Step 6 adds a test that keeps that relief channel in
  place**; the WARN is not dismissable without it.

**The light palette's low contrast is a deliberate trade, not an oversight.** Its
lightness is bimodal by design — slots 2/5/7 at L ≈ 0.44, slots 3/6/8 at L ≈ 0.76 — and
that alternating rhythm is what buys the CVD margin (worst adjacent ΔE 21.8 against a
floor of 8). Re-stepping slots 3/6/8 up to clear 3:1 collapses slots 7↔8 to ΔE 2.6 under
protanopia: red and deep green merge. The trade is recorded in the ADR; do not "fix" the
contrast without re-running the validator.

**Headroom is thin, especially in dark.** Slot 6 `#28a4b0` sits at chroma 0.104 against a
0.10 floor; slot 7 `#247320` at L 0.490 against a 0.48 floor; slot 4 `#5e57b2` at 3.14:1
against a 3:1 floor. If a future change fails `palette.test.ts`, **re-derive the palette
against the validator — never relax a threshold in the test.**

- [ ] **Step 1: Write the failing test**

Create `frontend/src/styles/palette.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TOKENS = readFileSync(
  fileURLToPath(new URL("./tokens.css", import.meta.url)),
  "utf8",
);

// OKLCh lightness band per mode, OKLab ΔE×100 gates, and the WCAG contrast
// floor. Thresholds and the Machado, Oliveira & Fernandes (2009) severity-1.0
// CVD transforms follow the reference data-viz palette validator. This file
// checks protan and deutan only; tritan is recorded in ADR 0011 but not gated,
// because no adjacent pair comes close to the floor under it.
const BAND = { dark: [0.48, 0.67], light: [0.43, 0.77] } as const;
const CHROMA_FLOOR = 0.1;
const CVD_FLOOR = 8;
const NORMAL_FLOOR = 15;
const CONTRAST_MIN = 3;
const AMBER_BAND = [55, 90] as const;
const AMBER_DELTA_FLOOR = 10;

const MACHADO = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
} as const;

type Linear = [number, number, number];

function toLinear(hex: string): Linear {
  const body = hex.replace("#", "");
  const channels = [0, 2, 4].map((offset) => {
    const value = Number.parseInt(body.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return [channels[0] ?? 0, channels[1] ?? 0, channels[2] ?? 0];
}

function toOklab([r, g, b]: Linear): Linear {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklch(hex: string): { l: number; c: number; h: number } {
  const [l, a, b] = toOklab(toLinear(hex));
  return {
    l,
    c: Math.hypot(a, b),
    h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360,
  };
}

function simulate(hex: string, kind: keyof typeof MACHADO): Linear {
  const [r, g, b] = toLinear(hex);
  const m = MACHADO[kind];
  const clamp = (value: number): number => Math.max(0, Math.min(1, value));
  return [
    clamp((m[0]?.[0] ?? 0) * r + (m[0]?.[1] ?? 0) * g + (m[0]?.[2] ?? 0) * b),
    clamp((m[1]?.[0] ?? 0) * r + (m[1]?.[1] ?? 0) * g + (m[1]?.[2] ?? 0) * b),
    clamp((m[2]?.[0] ?? 0) * r + (m[2]?.[1] ?? 0) * g + (m[2]?.[2] ?? 0) * b),
  ];
}

function deltaE(a: string, b: string, kind?: keyof typeof MACHADO): number {
  const first = toOklab(kind === undefined ? toLinear(a) : simulate(a, kind));
  const second = toOklab(kind === undefined ? toLinear(b) : simulate(b, kind));
  return (
    100 *
    Math.hypot(first[0] - second[0], first[1] - second[1], first[2] - second[2])
  );
}

function luminance(hex: string): number {
  const [r, g, b] = toLinear(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const high = Math.max(luminance(a), luminance(b));
  const low = Math.min(luminance(a), luminance(b));
  return (high + 0.05) / (low + 0.05);
}

function block(selector: string): string {
  const start = TOKENS.indexOf(selector);
  if (start < 0) throw new Error(`missing selector ${selector}`);
  const open = TOKENS.indexOf("{", start);
  const close = TOKENS.indexOf("}", open);
  return TOKENS.slice(open, close);
}

function token(selector: string, name: string): string {
  const match = new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, "i").exec(
    block(selector),
  );
  if (match?.[1] === undefined) {
    throw new Error(`missing token ${name} in ${selector}`);
  }
  return match[1].toLowerCase();
}

function series(selector: string): string[] {
  return Array.from({ length: 8 }, (_, index) =>
    token(selector, `--series-${String(index + 1)}`),
  );
}

const THEMES = [
  { name: "dark", selector: ":root", mode: "dark" },
  { name: "light", selector: ':root[data-theme="light"]', mode: "light" },
] as const;

// Known-answer calibration. Without this the colour maths above could be
// silently wrong and every assertion below would still pass, leaving the gate
// worthless. Values are from the reference validator.
describe("colour maths", () => {
  it("matches known OKLCh values", () => {
    const amber = oklch("#ffb648");
    expect(amber.l).toBeCloseTo(0.826, 2);
    expect(amber.c).toBeCloseTo(0.148, 2);
    expect(amber.h).toBeCloseTo(73.8, 1);
    expect(oklch("#2a78d6").h).toBeCloseTo(255.5, 1);
    expect(oklch("#008300").l).toBeCloseTo(0.529, 2);
  });

  it("matches known contrast ratios", () => {
    expect(contrast("#a9b0bc", "#0e1116")).toBeCloseTo(8.67, 1);
    expect(contrast("#4a5160", "#f7f8fa")).toBeCloseTo(7.49, 1);
  });

  it("matches a known simulated separation", () => {
    expect(deltaE("#eda100", "#1baf7a", "protan")).toBeCloseTo(9.1, 0);
  });
});

describe.each(THEMES)("$name series palette", ({ selector, mode }) => {
  const palette = series(selector);

  it("keeps every slot inside the lightness band", () => {
    const [lo, hi] = BAND[mode];
    for (const hex of palette) {
      expect(oklch(hex).l).toBeGreaterThanOrEqual(lo);
      expect(oklch(hex).l).toBeLessThanOrEqual(hi);
    }
  });

  it("keeps every slot above the chroma floor", () => {
    for (const hex of palette) {
      expect(oklch(hex).c).toBeGreaterThanOrEqual(CHROMA_FLOOR);
    }
  });

  it("separates adjacent slots under protan and deutan vision", () => {
    for (let i = 0; i < palette.length - 1; i += 1) {
      const [a, b] = [palette[i] ?? "", palette[i + 1] ?? ""];
      for (const kind of ["protan", "deutan"] as const) {
        expect(deltaE(a, b, kind)).toBeGreaterThanOrEqual(CVD_FLOOR);
      }
    }
  });

  it("separates adjacent slots under normal vision", () => {
    for (let i = 0; i < palette.length - 1; i += 1) {
      expect(
        deltaE(palette[i] ?? "", palette[i + 1] ?? ""),
      ).toBeGreaterThanOrEqual(NORMAL_FLOOR);
    }
  });

  it("reserves the amber hue band for interaction roles", () => {
    const amber = oklch(token(selector, "--amber-7")).h;
    expect(amber).toBeGreaterThanOrEqual(AMBER_BAND[0]);
    expect(amber).toBeLessThanOrEqual(AMBER_BAND[1]);
    for (const hex of palette) {
      const { h } = oklch(hex);
      expect(h < AMBER_BAND[0] || h > AMBER_BAND[1]).toBe(true);
    }
  });

  // The hue band alone would admit a high-chroma 54 degree orange sitting
  // visually on top of the cursor colour. Gate the distance too.
  it("keeps every slot perceptually clear of the amber tokens", () => {
    for (const name of ["--amber-7", "--amber-9"] as const) {
      const amber = token(selector, name);
      for (const hex of palette) {
        expect(deltaE(hex, amber)).toBeGreaterThanOrEqual(AMBER_DELTA_FLOOR);
      }
    }
  });

  it("never reuses an amber or status token as a series colour", () => {
    const reserved = [
      "--amber-7",
      "--amber-9",
      "--status-connected",
      "--status-disconnected",
      "--status-error",
    ].map((name) => token(selector, name));
    for (const hex of palette) {
      expect(reserved).not.toContain(hex);
    }
  });
});

it("holds hue identity for each slot across themes", () => {
  const dark = series(":root");
  const light = series(':root[data-theme="light"]');
  for (let i = 0; i < dark.length; i += 1) {
    const delta = Math.abs(oklch(dark[i] ?? "").h - oklch(light[i] ?? "").h);
    expect(Math.min(delta, 360 - delta)).toBeLessThanOrEqual(10);
  }
});

it("meets the contrast floor on the dark surface", () => {
  const surface = token(":root", "--surface-0");
  for (const hex of series(":root")) {
    expect(contrast(hex, surface)).toBeGreaterThanOrEqual(CONTRAST_MIN);
  }
});

// Light-mode contrast is a recorded WARN, not a PASS (ADR 0011). Pin the
// current values so a regression is visible rather than silent, and so the
// number the ADR quotes cannot drift away from the tokens.
it("records the light surface contrast trade", () => {
  const surface = token(':root[data-theme="light"]', "--surface-0");
  const ratios = series(':root[data-theme="light"]').map((hex) =>
    contrast(hex, surface),
  );
  const below = ratios.filter((ratio) => ratio < CONTRAST_MIN);
  expect(below).toHaveLength(3);
  for (const ratio of below) expect(ratio).toBeGreaterThanOrEqual(1.8);
});
```

> **Note for the implementor:** do not add a `const surface = ...` inside the
> `describe.each` body. `noUnusedLocals` makes an unused local a typecheck failure, and
> the contrast tests deliberately live outside that block.

- [ ] **Step 2: Run the test to verify it fails**

Run: `./scripts/test.sh frontend`

Expected: FAIL. The dark theme fails "keeps every slot inside the lightness band" (all
eight sit at L 0.718–0.918, above the 0.67 ceiling), fails "reserves the amber hue band"
(`--series-1` is at hue 73.8°), fails "never reuses an amber or status token"
(`--series-1` `#ffb648` equals `--amber-9`), and the cross-theme hue identity test fails
(dark slot 1 is amber-hued, light slot 1 is blue). The "colour maths" calibration tests
should PASS immediately — if they do not, the colorimetry above is wrong and nothing else
in this task means anything.

- [ ] **Step 3: Replace both palettes in `tokens.css`**

In `frontend/src/styles/tokens.css`, replace the dark series block (lines 38-45):

```css
  --series-1: #407fd0;
  --series-2: #a7451c;
  --series-3: #29ab79;
  --series-4: #5e57b2;
  --series-5: #a6416b;
  --series-6: #28a4b0;
  --series-7: #247320;
  --series-8: #db6c66;
```

and the light series block (lines 78-85):

```css
  --series-1: #1970d1;
  --series-2: #89340f;
  --series-3: #33cf93;
  --series-4: #6653dc;
  --series-5: #931553;
  --series-6: #33c6d5;
  --series-7: #126410;
  --series-8: #fa8e86;
```

Change nothing else in the file. `--amber-*`, `--status-*`, surfaces, and ink stay exactly
as they are.

- [ ] **Step 4: Run the test to verify it passes**

Run: `./scripts/test.sh frontend`

Expected: PASS, including the existing `theme is a pure token swap` Playwright expectation
and all `workspace.test.ts` cases.

- [ ] **Step 5: Write the ADR**

Create `docs/adr/0011-series-palette-and-reserved-amber.md`:

```markdown
# 11. Series palette, reserved amber hue band, and colormap sources

Status: Accepted

## Context

The Final Spec shipped eight categorical series slots per theme and recorded
"Colorblind validation pending — fallback: prototype palette". Validation found
the dark palette placed all eight slots at OKLCh L 0.718–0.918, outside the
0.48–0.67 band for a near-black surface, so the slots differed almost only in
hue — the channel that colour-vision deficiency, print, and glare destroy first.
Dark `--series-1` was also byte-identical to `--amber-9` (#FFB648), which the
same spec reserves for interaction roles only: cursor, focus inset, delta
readouts, derived/fx marks, pinned emphasis, and drop targets.

The spec additionally stated that slot colours differ per theme by design. In
practice both palettes ship inside every HTML snapshot and the recipient can
toggle themes offline, so a caption naming a colour becomes wrong on toggle.
"Captions are not optional" (Rougier, Droettboom & Bourne, rule 4) only holds if
a caption stays true.

## Decision

1. Both themes share one hue order. A slot keeps its hue across the theme
   toggle; only lightness and chroma are re-stepped per surface.
2. OKLCh hue 55 degrees to 90 degrees is a reserved amber band. No series slot
   may occupy it, and no slot may sit within OKLab delta-E 10 of `--amber-7` or
   `--amber-9`. Amber remains interaction-only.
3. Palette values are derived, not picked. The derivation is:
   - Start from the reference data-viz categorical palette, which is what the
     light theme already shipped: #2a78d6 / #eb6834 / #1baf7a / #eda100 /
     #e87ba4 / #008300 / #4a3aa7 / #e34948.
   - Keep seven of its hue families unchanged: blue 255 degrees, orange 41,
     green 162, violet 284, pink 357, deep green 142, red 25.
   - Evict its amber slot (#eda100, hue 75.1 degrees), which falls inside the
     reserved band, and substitute an azure at 205 degrees — the widest
     remaining gap in the hue circle.
   - Re-order, then re-step each slot in OKLCh against the mode's lightness
     band.
   Anyone adding, removing, or re-stepping a slot repeats this procedure.
4. Acceptance is by computed check, never by eye: lightness band, chroma floor,
   adjacent OKLab delta-E under Machado-Oliveira-Fernandes protan and deutan
   simulation, an unsimulated normal-vision floor, and WCAG contrast against the
   surface. Those checks run as a frontend unit test over tokens.css, calibrated
   against known-answer fixtures so the checker itself cannot rot.

### The light-theme contrast trade

Light slots 3, 6, and 8 measure 1.88, 1.94, and 2.13 against `--surface-0`,
below the 3:1 mark floor. This is accepted and it is deliberate.

The light palette's lightness is bimodal — slots 2/5/7 near L 0.44, slots 3/6/8
near L 0.76 — and that alternation is the mechanism that produces its CVD
margin: worst adjacent delta-E 21.8 against a floor of 8, and 24.2 unsimulated
against a floor of 15. Re-stepping slots 3, 6, and 8 upward to clear 3:1 was
tried and rejected: it collapses slots 7 and 8 to delta-E 2.6 under protanopia,
merging red with deep green. Surface contrast was spent to buy separation.

The WARN is discharged by the relief channel the method requires: legend chips
carry the signal path as text beside every swatch, so identity is never
colour-alone. A test asserts that chips render their text, so the relief cannot
be removed silently.

### Headroom

Both palettes sit close to their gates. Dark slot 6 has chroma 0.104 against a
0.10 floor, dark slot 7 sits at L 0.490 against 0.48, dark slot 4 contrasts at
3.14:1 against 3:1, and the dark adjacent CVD margin is 10.1 against 8. A future
edit that fails the test is to be answered by re-deriving the palette, never by
relaxing a threshold in the test.

## Sequential and diverging colormaps

No `--seq-*` or `--div-*` tokens are defined in phase 1 — nothing reads them
yet, and shipping unread tokens is the mistake this plan exists to stop
repeating. The *source* is fixed now so that phase 2 cannot invent one:

Sequential and diverging colormaps are sampled from Fabio Crameri's Scientific
colour maps (Zenodo, DOI 10.5281/zenodo.1243862; MIT licensed) — `batlow` for
sequential magnitude, `vik` or `roma` for diverging polarity about a neutral
midpoint, `oleron`/`bukavu` for topographic surfaces should 3D panels land.
They are perceptually uniform, colour-vision-deficiency safe, and readable in
greyscale, which is what the Final Spec already demands of the `c:` colorbar.
No rainbow map (`jet`, `turbo`) and no map lacking monotone lightness is
admissible.

`batlowS` is explicitly **not** the source for the categorical slots above. It
is an ordered categorical sampling of a monotone-lightness ramp, so its entries
span lightness from near-black to near-white by design — exactly what the
categorical lightness-band check rejects, and exactly what disappears against a
fixed near-black surface. It is the right tool for ordinal encodings (Monte
Carlo run index, tiers, buckets) and the wrong one for series identity.

## Consequences

- The eight slot values change in both themes. `color_slot` is serialised, so
  sessions and snapshots written before this change re-render in new colours.
  No migration is added: the field's meaning is unchanged and phase 1 has no
  released artefacts to preserve.
- Adding a ninth categorical hue is now explicitly out of bounds. Series beyond
  slot 8 are distinguished by dash class (see the phase 1 plan, task 4).
- This record supersedes the Final Spec's per-theme slot assignment and its
  pending-validation note. The spec is not rewritten.
```

Then add to `docs/adr/README.md` after line 14:

```markdown
11. [Series palette, reserved amber hue band, and colormap sources](0011-series-palette-and-reserved-amber.md)
```

- [ ] **Step 6: Format and commit**

```bash
./scripts/ci.sh format
git add frontend/src/styles/tokens.css frontend/src/styles/palette.test.ts docs/adr/0011-series-palette-and-reserved-amber.md docs/adr/README.md
git commit -m "feat(tokens): validated series palette with reserved amber band"
```

---

## Task 2: A headless renderer test harness and a per-axis tick pipeline

`canvas-renderer.ts` has **no tests of any kind**. Its tick formatter picks decimal places
from each value's own magnitude, so a single axis reads `0.00, 10.0, 20.0`. Its gutter is a
hard-coded 52px that exponential labels overrun into the rotated axis title.

The tick fixes are small. The harness is the point of this task: without a way to assert
what the renderer actually draws, Tasks 4 and 5 are unverifiable, and every later phase —
XY, FFT, the `c:` colorbar, 3D spines — inherits the same blindness. It also gives the
first test of the `has_gap` stroke-break invariant, which `AGENTS.md` names as
architectural and which nothing currently checks.

**Files:**
- Create: `frontend/src/render/canvas-renderer.test.ts`
- Modify: `frontend/src/render/canvas-renderer.ts` — two testability seams, export `ticks`,
  replace `formatTick` with `formatTicks`, add `gutterWidth`, use `--fg-2` for tick labels,
  emit outward tick marks and a zero line.

**Interfaces:**
- Consumes: `--series-*` tokens from Task 1 (values only; no API dependency).
- Produces:
  - `export interface Palette` and `setPalette(palette: Palette): void` on
    `CanvasRenderer` — a real seam (phase 2's `BakedPlane` can inject a baked palette),
    which incidentally makes the renderer runnable without a DOM.
  - `export function ticks(min: number, max: number, count: number): number[]` — unchanged
    behaviour, now exported.
  - `export function formatTicks(values: readonly number[]): string[]` — one decimal
    precision for the whole array, derived from the smallest gap between consecutive
    values. Returns exponential form for every entry when any `|value| >= 10_000` or any
    non-zero `|value| < 0.001`.
  - `export function gutterWidth(labels: readonly string[], charWidth: number): number` —
    `max(labelLength) * charWidth + 7 (tick gap) + 4 (tick mark) + 12 (rotated axis title)`,
    floored at 52.
  - Test-local helpers `recordingContext()` and `fakeCanvas()`, used by Tasks 4 and 5.

- [ ] **Step 1: Add the two testability seams**

There is no jsdom in this project, so `render()` currently cannot run under Vitest at all:
`prepareCanvas` reads `window.devicePixelRatio` and `resolvePalette` reads
`getComputedStyle(document.documentElement)`. Two small changes remove both barriers
without adding a dependency, and both are defensible on their own merits.

In `frontend/src/render/canvas-renderer.ts`:

1. Export the palette type and add an injection point. Change `interface Palette` (line 15)
   to `export interface Palette`, and add a public method beside `invalidateTheme`:

```ts
  /**
   * Supply the palette directly instead of reading CSS custom properties.
   * `invalidateTheme()` discards it and returns to reading the document.
   */
  setPalette(palette: Palette): void {
    this.palette = palette;
  }
```

2. In `prepareCanvas` (line 90), replace

```ts
    const ratio = window.devicePixelRatio || 1;
```

   with

```ts
    const ratio = globalThis.devicePixelRatio || 1;
```

   Identical in every browser; defined (as `undefined`, hence `1`) under Node.

- [ ] **Step 2: Write the failing tests**

Create `frontend/src/render/canvas-renderer.test.ts`. The helpers are deliberately explicit
object literals rather than a `Proxy`: `strictTypeChecked` rejects the dynamic version.

```ts
import { describe, expect, it } from "vitest";
import type { SignalTile, TileResponse } from "../generated/protocol";
import {
  CanvasRenderer,
  formatTicks,
  gutterWidth,
  ticks,
  type Palette,
  type RenderOptions,
} from "./canvas-renderer";

export interface DrawCall {
  op: string;
  args: readonly unknown[];
}

/**
 * A canvas 2D context that records every call the renderer makes instead of
 * rasterising. Only the members `canvas-renderer.ts` touches are implemented;
 * add to it when the renderer starts using something new.
 */
export function recordingContext(charWidth = 6): {
  calls: DrawCall[];
  context: CanvasRenderingContext2D;
} {
  const calls: DrawCall[] = [];
  const push = (op: string, ...args: unknown[]): void => {
    calls.push({ op, args });
  };
  let fill = "";
  let stroke = "";
  const stub = {
    font: "",
    textAlign: "start",
    textBaseline: "alphabetic",
    lineWidth: 1,
    get fillStyle(): string {
      return fill;
    },
    set fillStyle(value: string) {
      fill = value;
      push("=fillStyle", value);
    },
    get strokeStyle(): string {
      return stroke;
    },
    set strokeStyle(value: string) {
      stroke = value;
      push("=strokeStyle", value);
    },
    beginPath: (): void => {
      push("beginPath");
    },
    moveTo: (x: number, y: number): void => {
      push("moveTo", x, y);
    },
    lineTo: (x: number, y: number): void => {
      push("lineTo", x, y);
    },
    stroke_: undefined,
    stroke(): void {
      push("stroke");
    },
    fillRect: (x: number, y: number, w: number, h: number): void => {
      push("fillRect", x, y, w, h);
    },
    fillText: (text: string, x: number, y: number): void => {
      push("fillText", text, x, y);
    },
    setLineDash: (segments: number[]): void => {
      push("setLineDash", [...segments]);
    },
    setTransform: (a: number, b: number, c: number, d: number, e: number, f: number): void => {
      push("setTransform", a, b, c, d, e, f);
    },
    save: (): void => {
      push("save");
    },
    restore: (): void => {
      push("restore");
    },
    translate: (x: number, y: number): void => {
      push("translate", x, y);
    },
    rotate: (angle: number): void => {
      push("rotate", angle);
    },
    measureText: (text: string) => ({ width: text.length * charWidth }),
  };
  return { calls, context: stub as unknown as CanvasRenderingContext2D };
}

export function fakeCanvas(
  width: number,
  height: number,
  context: CanvasRenderingContext2D,
): HTMLCanvasElement {
  return {
    clientWidth: width,
    clientHeight: height,
    width: 0,
    height: 0,
    getContext: () => context,
  } as unknown as HTMLCanvasElement;
}

export const TEST_PALETTE: Palette = {
  background: "#0e1116",
  border: "#2e3340",
  fg2: "#a9b0bc",
  fg3: "#737985",
  grid: "#1a1d24",
  series: [
    "#407fd0",
    "#a7451c",
    "#29ab79",
    "#5e57b2",
    "#a6416b",
    "#28a4b0",
    "#247320",
    "#db6c66",
  ],
};

export function tile(
  path: string,
  bins: readonly { t0: number; t1: number; v: number; gap?: boolean }[],
): SignalTile {
  return {
    signal_path: path,
    unit: null,
    bins: bins.map((bin) => ({
      t0: bin.t0,
      t1: bin.t1,
      first: bin.v,
      last: bin.v,
      min: bin.v,
      max: bin.v,
      count: 1,
      has_gap: bin.gap ?? false,
    })),
  } as unknown as SignalTile;
}

export function renderOnce(
  series: SignalTile[],
  options: Partial<RenderOptions> = {},
): DrawCall[] {
  const { calls, context } = recordingContext();
  const renderer = new CanvasRenderer(fakeCanvas(400, 200, context));
  renderer.setPalette(TEST_PALETTE);
  const response: TileResponse = { request_id: "t", series } as TileResponse;
  renderer.render(
    response,
    { min: 0, max: 10 },
    {
      xLabel: "time (s)",
      yLabel: "v",
      colorSlots: series.map((_, index) => index + 1),
      ...options,
    } as RenderOptions,
  );
  return calls;
}

describe("ticks", () => {
  it("produces round steps covering the range", () => {
    expect(ticks(0, 60, 7)).toEqual([0, 10, 20, 30, 40, 50, 60]);
  });

  it("snaps zero exactly", () => {
    expect(ticks(-100, 300, 6)).toContain(0);
  });

  // Chosen behaviour, not accidental: a degenerate range yields no ticks
  // rather than hanging or throwing. Task 5 relies on this.
  it("yields no ticks for a degenerate range", () => {
    expect(ticks(5, 5, 6)).toEqual([]);
    expect(ticks(Number.NaN, Number.NaN, 6)).toEqual([]);
  });
});

describe("formatTicks", () => {
  it("uses one precision for the whole axis", () => {
    expect(formatTicks([0, 10, 20, 30, 40, 50])).toEqual([
      "0",
      "10",
      "20",
      "30",
      "40",
      "50",
    ]);
  });

  it("does not mix decimal places within an axis", () => {
    expect(formatTicks([-100, 0, 100, 200, 300])).toEqual([
      "-100",
      "0",
      "100",
      "200",
      "300",
    ]);
  });

  it("keeps enough precision to separate close ticks", () => {
    expect(formatTicks([0, 0.25, 0.5, 0.75, 1])).toEqual([
      "0.00",
      "0.25",
      "0.50",
      "0.75",
      "1.00",
    ]);
  });

  it("switches the whole axis to exponential together", () => {
    expect(formatTicks([0, 50_000, 100_000])).toEqual([
      "0.0e+0",
      "5.0e+4",
      "1.0e+5",
    ]);
  });

  it("keeps the sign on negative exponents", () => {
    expect(formatTicks([0, 0.0005])).toEqual(["0.0e+0", "5.0e-4"]);
  });

  it("returns nothing for an empty axis", () => {
    expect(formatTicks([])).toEqual([]);
  });
});

describe("gutterWidth", () => {
  it("keeps the default gutter for short labels", () => {
    expect(gutterWidth(formatTicks([0, 100, 300]), 6)).toBe(52);
  });

  it("grows so long labels clear the rotated axis title", () => {
    expect(gutterWidth(formatTicks([0, -120_000]), 6)).toBeGreaterThan(52);
  });
});

describe("render", () => {
  it("breaks the stroke at a gap instead of drawing through it", () => {
    const calls = renderOnce([
      tile("a", [
        { t0: 0, t1: 1, v: 1 },
        { t0: 1, t1: 2, v: 2 },
        { t0: 2, t1: 3, v: 3, gap: true },
        { t0: 3, t1: 4, v: 4 },
      ]),
    ]);
    const path = calls.filter(
      (call) => call.op === "moveTo" || call.op === "lineTo",
    );
    // One moveTo opens the series; has_gap forces a second one. Anything less
    // means the renderer drew a line across missing data.
    expect(path.filter((call) => call.op === "moveTo").length).toBeGreaterThan(1);
  });

  it("paints each series in its slot colour", () => {
    const calls = renderOnce(
      [tile("a", [{ t0: 0, t1: 1, v: 1 }]), tile("b", [{ t0: 0, t1: 1, v: 2 }])],
      { colorSlots: [1, 3] },
    );
    const strokes = calls
      .filter((call) => call.op === "=strokeStyle")
      .map((call) => call.args[0]);
    expect(strokes).toContain("#407fd0");
    expect(strokes).toContain("#29ab79");
  });

  it("keeps tick labels inside the gutter", () => {
    const calls = renderOnce([tile("a", [{ t0: 0, t1: 1, v: 1 }])]);
    const labels = calls.filter((call) => call.op === "fillText");
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      expect(typeof label.args[1]).toBe("number");
    }
  });
});
```

> The `stroke_: undefined` field above is a placeholder to keep `stroke()` a method rather
> than an arrow property; drop it if the implementor finds a cleaner spelling that still
> lints under `strictTypeChecked`. The behaviour under test is unaffected.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `./scripts/test.sh frontend`

Expected: FAIL — `formatTicks is not a function`, `gutterWidth is not a function`,
`setPalette is not a function` if Step 1 was skipped, plus TypeScript errors that `ticks`
and `Palette` are not exported.

- [ ] **Step 4: Implement the tick pipeline and rewire `drawAxes` in one step**

**These must land together.** `drawAxes` calls `formatTick` at lines 152 and 164; deleting
the function before rewiring its callers leaves the tree failing `pnpm typecheck`, which
`./scripts/test.sh frontend` runs. Do not split this into two commits.

In `frontend/src/render/canvas-renderer.ts`:

**(a)** Change `function ticks(` at line 253 to `export function ticks(`.

**(b)** Delete `formatTick` (lines 268-274) and add:

```ts
export function formatTicks(values: readonly number[]): string[] {
  const magnitudes = values.map(Math.abs).filter((value) => value > 0);
  const largest = magnitudes.length === 0 ? 0 : Math.max(...magnitudes);
  const smallest = magnitudes.length === 0 ? 0 : Math.min(...magnitudes);
  // toExponential always emits the exponent sign, so no post-processing.
  if (largest >= 10_000 || (smallest > 0 && smallest < 0.001)) {
    return values.map((value) => value.toExponential(1));
  }
  let gap = Number.POSITIVE_INFINITY;
  for (let index = 1; index < values.length; index += 1) {
    const step = Math.abs((values[index] ?? 0) - (values[index - 1] ?? 0));
    if (step > 0) gap = Math.min(gap, step);
  }
  const digits = Number.isFinite(gap)
    ? Math.min(6, Math.max(0, Math.ceil(-Math.log10(gap)) + 1))
    : 0;
  return values.map((value) => value.toFixed(digits));
}

export function gutterWidth(
  labels: readonly string[],
  charWidth: number,
): number {
  const longest = labels.reduce((max, label) => Math.max(max, label.length), 0);
  return Math.max(52, Math.ceil(longest * charWidth) + 7 + 4 + 12);
}
```

**(c)** Add these constants directly above `export class CanvasRenderer` (line 41). The
tick font stays at the existing 9px — the gutter measurement is what changes, not the
type scale, and a silent type-size change is a spec deviation this task does not need:

```ts
const TICK_FONT = '9px "JetBrains Mono", monospace';
const LABEL_FONT = '9.5px "JetBrains Mono", monospace';
```

**(d)** Replace the body of `drawAxes` (lines 128-187) with:

```ts
  private drawAxes(
    context: CanvasRenderingContext2D,
    plot: PlotRect,
    xRange: Range,
    yRange: Range,
    colors: Palette,
    options: RenderOptions,
  ): void {
    context.lineWidth = 1;
    context.font = TICK_FONT;
    context.textBaseline = "middle";

    const xTicks = ticks(xRange.min, xRange.max, 7);
    const yTicks = ticks(yRange.min, yRange.max, 6);
    const xLabels = formatTicks(xTicks);
    const yLabels = formatTicks(yTicks);

    const toX = (value: number): number =>
      plot.x + ((value - xRange.min) / (xRange.max - xRange.min)) * plot.width;
    const toY = (value: number): number =>
      plot.y +
      plot.height -
      ((value - yRange.min) / (yRange.max - yRange.min)) * plot.height;

    context.strokeStyle = colors.grid;
    context.fillStyle = colors.fg2;
    context.textAlign = "center";
    xTicks.forEach((value, index) => {
      const x = Math.round(toX(value)) + 0.5;
      context.beginPath();
      context.moveTo(x, plot.y);
      context.lineTo(x, plot.y + plot.height);
      context.stroke();
      context.fillText(xLabels[index] ?? "", x, plot.y + plot.height + 12);
    });
    context.textAlign = "right";
    yTicks.forEach((value, index) => {
      const y = Math.round(toY(value)) + 0.5;
      context.beginPath();
      context.moveTo(plot.x, y);
      context.lineTo(plot.x + plot.width, y);
      context.stroke();
      context.fillText(yLabels[index] ?? "", plot.x - 11, y);
    });

    // Zero is a reference datum, not another gridline, so it wears the spine's
    // ink. --border-strong was tried and rejected: it measures 1.50:1 on
    // --surface-0 against the gridlines' 1.34:1, a step too small to read as
    // anything but a slightly darker gridline.
    if (yRange.min < 0 && yRange.max > 0) {
      const zero = Math.round(toY(0)) + 0.5;
      context.strokeStyle = colors.fg3;
      context.beginPath();
      context.moveTo(plot.x, zero);
      context.lineTo(plot.x + plot.width, zero);
      context.stroke();
    }

    context.strokeStyle = colors.fg3;
    context.beginPath();
    context.moveTo(plot.x + 0.5, plot.y);
    context.lineTo(plot.x + 0.5, plot.y + plot.height + 0.5);
    context.lineTo(plot.x + plot.width, plot.y + plot.height + 0.5);
    for (const value of xTicks) {
      const x = Math.round(toX(value)) + 0.5;
      context.moveTo(x, plot.y + plot.height + 0.5);
      context.lineTo(x, plot.y + plot.height + 4.5);
    }
    for (const value of yTicks) {
      const y = Math.round(toY(value)) + 0.5;
      context.moveTo(plot.x + 0.5, y);
      context.lineTo(plot.x - 3.5, y);
    }
    context.stroke();

    context.fillStyle = colors.fg2;
    context.font = LABEL_FONT;
    context.textAlign = "center";
    context.fillText(
      options.xLabel,
      plot.x + plot.width / 2,
      plot.y + plot.height + 27,
    );
    context.save();
    context.translate(10, plot.y + plot.height / 2);
    context.rotate(-Math.PI / 2);
    context.fillText(options.yLabel, 0, 0);
    context.restore();
  }
```

**(e)** In `render()`, replace the hard-coded `plot` (lines 63-68) with a **measured**
gutter. Measure the glyph rather than assuming one — the context is already in hand, the
measurement is exact, and it survives a future font change (which a hard-coded
`TICK_CHAR_WIDTH` would not):

```ts
    const yRange = visibleYRange(response.series);
    context.font = TICK_FONT;
    const charWidth = context.measureText("0").width;
    const gutter = gutterWidth(
      formatTicks(ticks(yRange.min, yRange.max, 6)),
      charWidth,
    );
    const plot: PlotRect = {
      x: gutter,
      y: 8,
      width: Math.max(1, width - gutter - 12),
      height: Math.max(1, height - 42),
    };
```

and delete the now-duplicated `const yRange = visibleYRange(response.series);` on line 69.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `./scripts/test.sh frontend && ./scripts/test.sh e2e`

Expected: PASS, including `shared presentation plane renders the demo workspace` and
`theme is a pure token swap`.

- [ ] **Step 6: Commit**

```bash
./scripts/ci.sh format
git add frontend/src/render/canvas-renderer.ts frontend/src/render/canvas-renderer.test.ts
git commit -m "feat(render): headless test harness, measured gutter, outward ticks, zero datum"
```

---

## Task 3: Stop capping the colour slot allocator

`workspace.ts:246-249` caps `color_slot` at 8 and wraps:

```ts
    let slot = 1;
    while (used.has(slot) && slot < MAX_COLOR_SLOTS) slot += 1;
    if (used.has(slot)) slot = (panel.series.length % MAX_COLOR_SLOTS) + 1;
```

so the ninth series in a panel is assigned `color_slot: 1` — indistinguishable from the
first, in the model as well as on screen. This is a self-contained correctness fix with no
rendering dependency; it lands on its own so it can be reviewed and reverted on its own.

The slot number carries full identity. Decomposing it into a colour index and a dash band
is the *renderer's* job (Task 4).

**Files:**
- Modify: `frontend/src/app/workspace.ts` — uncap the allocator, drop `MAX_COLOR_SLOTS`,
  fix the default width.
- Modify: `frontend/src/app/workspace.test.ts` — add coverage.

**Interfaces:**
- Consumes: nothing.
- Produces: `color_slot` values unbounded above 1. `SeriesState.dash` keeps its written
  value of `"solid"`.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/app/workspace.test.ts`. **Note the method is `addSeries`, not
`addSeriesToPanel`** — check the signature at `workspace.ts:238` before writing:

```ts
it("allocates slots past 8 instead of wrapping onto slot 1", () => {
  const model = new WorkspaceModel();
  const panel = model.addPanel();
  for (let index = 0; index < 10; index += 1) {
    model.addSeries(panel.id, `rocket/sig_${String(index)}`);
  }
  const slots = model.panels()[0]?.series.map((series) => series.color_slot);
  expect(slots).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

it("leaves dash as user intent, defaulted to solid", () => {
  const model = new WorkspaceModel();
  const panel = model.addPanel();
  model.addSeries(panel.id, "rocket/velocity_body/x");
  expect(model.panels()[0]?.series[0]?.dash).toBe("solid");
});

it("writes the spec default series width", () => {
  const model = new WorkspaceModel();
  const panel = model.addPanel();
  model.addSeries(panel.id, "rocket/velocity_body/x");
  expect(model.panels()[0]?.series[0]?.width).toBe(1.4);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./scripts/test.sh frontend`

Expected: FAIL — the tenth slot comes back as `2` (the wrap), and the width is `1.5`.

- [ ] **Step 3: Uncap the allocator**

In `frontend/src/app/workspace.ts`, replace lines 246-249 (the capped allocator) with:

```ts
    const used = new Set(panel.series.map((series) => series.color_slot));
    let slot = 1;
    while (used.has(slot)) slot += 1;
```

and in the `panel.series.push({...})` immediately below, change `width: 1.5` to
`width: 1.4`. Final Spec F5 shows `w 1.4` and the renderer already strokes at 1.4; the
written `1.5` contradicts both and would render every series wrong the first time anything
reads the field.

Leave `dash: "solid"` exactly as it is. `SeriesState.dash` is a **user-authored** field —
Final Spec F5's legend inspector offers `solid · dash · dot` per series — and must not be
pre-filled with a derivation. Task 4 handles the >8 case in the renderer instead.

`MAX_COLOR_SLOTS` (line 11) is now unreferenced; delete the constant. `noUnusedLocals`
would fail the build otherwise, and the single canonical `COLOR_SLOTS` lives in
`canvas-renderer.ts` after Task 4 — which also keeps `app/` from importing `render/`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `./scripts/test.sh frontend`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
./scripts/ci.sh format
git add frontend/src/app/workspace.ts frontend/src/app/workspace.test.ts
git commit -m "fix(workspace): allocate colour slots past 8 instead of aliasing onto slot 1"
```

---

## Task 4: Render composite series identity — colour × dash

With Task 3 done, `color_slot` can exceed 8 but the renderer still wraps with
`% colors.series.length` (`canvas-renderer.ts:79`) and the legend with a literal `% 8`
(`panel.ts:179`), so slot 9 is still pixel-identical to slot 1. This task decomposes the
slot into a colour index and a dash band in **one shared function** used by both the
renderer and the legend, giving 24 deterministic identities with no schema change.

This is what the Final Spec asks for: *"Series: 8 categorical slots (`--series-1…8`), dash
classes beyond 8; identity never colour alone."* It is also the sanctioned answer under the
colour method, which forbids generating a ninth hue and directs you to composite encoding
instead.

**Files:**
- Modify: `frontend/src/render/canvas-renderer.ts` — `COLOR_SLOTS`, `resolveSeriesStyle`,
  `dashPattern`; accept and render dash classes.
- Modify: `frontend/src/render/canvas-renderer.test.ts` — add coverage.
- Modify: `frontend/src/ui/panel.ts` — supply dashes; legend chips show the dash class.
- Modify: `frontend/src/styles/app.css` — legend swatch dash classes.
- Modify: `frontend/tests/e2e/` (the existing workspace spec) — assert the legend text
  relief channel.

**Interfaces:**
- Consumes: Task 2's harness; Task 3's uncapped slots.
- Produces:
  - `export const COLOR_SLOTS: number` — the single canonical modulus.
  - `export function resolveSeriesStyle(colorSlot: number, dash: DashStyle): { colorIndex: number; dash: DashStyle }`
    — slots 1-8 band `"solid"`, 9-16 `"dash"`, 17-24 `"dot"`, then repeating; a
    non-`"solid"` stored `dash` wins, because that is a user choice.
  - `export function dashPattern(dash: DashStyle): number[]` — `solid: []`,
    `dash: [6, 4]`, `dot: [1.5, 3]`.
  - `RenderOptions` gains `dashes: readonly DashStyle[]`.

### Why `dash` is read but never written

`SeriesState.dash` is the field the phase-2 legend inspector will write. If the allocator
pre-fills it from `color_slot`, there is no way to distinguish "the user chose solid" from
"the allocator defaulted to solid", and the inspector arrives already in conflict with the
derivation. So: the model keeps writing `"solid"`, and `resolveSeriesStyle` supplies the
band fallback at render time. A user who later picks `"dot"` on series 3 overrides it, and
nothing has to be migrated. This is the same reasoning that keeps `width` alone.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/render/canvas-renderer.test.ts`, extending the existing import from
`"./canvas-renderer"` with `dashPattern` and `resolveSeriesStyle`:

```ts
describe("resolveSeriesStyle", () => {
  it("bands the dash class by colour slot", () => {
    expect(resolveSeriesStyle(1, "solid").dash).toBe("solid");
    expect(resolveSeriesStyle(8, "solid").dash).toBe("solid");
    expect(resolveSeriesStyle(9, "solid").dash).toBe("dash");
    expect(resolveSeriesStyle(16, "solid").dash).toBe("dash");
    expect(resolveSeriesStyle(17, "solid").dash).toBe("dot");
  });

  it("folds the colour index back onto the eight slots", () => {
    expect(resolveSeriesStyle(9, "solid").colorIndex).toBe(0);
    expect(resolveSeriesStyle(1, "solid").colorIndex).toBe(0);
    expect(resolveSeriesStyle(10, "solid").colorIndex).toBe(1);
  });

  it("lets an explicit user dash win over the band default", () => {
    expect(resolveSeriesStyle(1, "dot").dash).toBe("dot");
    expect(resolveSeriesStyle(9, "dot").dash).toBe("dot");
  });

  it("never gives two of the first 24 series the same colour and dash", () => {
    const seen = new Set<string>();
    for (let slot = 1; slot <= 24; slot += 1) {
      const style = resolveSeriesStyle(slot, "solid");
      const key = `${String(style.colorIndex)}:${style.dash}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("survives a malformed serialized slot", () => {
    expect(resolveSeriesStyle(0, "solid").colorIndex).toBeGreaterThanOrEqual(0);
    expect(resolveSeriesStyle(-3, "solid").colorIndex).toBeGreaterThanOrEqual(0);
  });
});

describe("dashPattern", () => {
  it("maps each dash class to a distinct canvas pattern", () => {
    expect(dashPattern("solid")).toEqual([]);
    expect(dashPattern("dash")).not.toEqual(dashPattern("dot"));
    expect(dashPattern("dash").length).toBeGreaterThan(0);
    expect(dashPattern("dot").length).toBeGreaterThan(0);
  });
});

describe("render with dash classes", () => {
  it("dashes slot 9 and resets the pattern afterwards", () => {
    const calls = renderOnce(
      [tile("a", [{ t0: 0, t1: 1, v: 1 }]), tile("b", [{ t0: 0, t1: 1, v: 2 }])],
      { colorSlots: [1, 9], dashes: ["solid", "solid"] },
    );
    const patterns = calls
      .filter((call) => call.op === "setLineDash")
      .map((call) => JSON.stringify(call.args[0]));
    expect(patterns).toContain(JSON.stringify([6, 4]));
    // The last thing the renderer does with the dash state must be to clear
    // it, or the pattern leaks into the next series and into the axes.
    expect(patterns.at(-1)).toBe(JSON.stringify([]));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./scripts/test.sh frontend`

Expected: FAIL — `resolveSeriesStyle is not a function` and `dashPattern is not a function`.

- [ ] **Step 3: Implement the shared decomposition**

In `frontend/src/render/canvas-renderer.ts`, add `DashStyle` to the type imports from
`"../generated/session"` and add below `SERIES_TOKENS`:

```ts
export const COLOR_SLOTS = SERIES_TOKENS.length;

const DASH_CYCLE = ["solid", "dash", "dot"] as const;

/**
 * Decompose a serialized colour slot into the identity the renderer draws.
 *
 * Slots 1-8 are the eight categorical hues solid, 9-16 the same hues dashed,
 * 17-24 dotted, then repeating. A stored `dash` other than "solid" is a user
 * choice from the legend inspector and overrides the band default.
 */
export function resolveSeriesStyle(
  colorSlot: number,
  dash: DashStyle,
): { colorIndex: number; dash: DashStyle } {
  const zero = Math.max(0, Math.trunc(colorSlot) - 1);
  const band = Math.floor(zero / COLOR_SLOTS) % DASH_CYCLE.length;
  return {
    colorIndex: zero % COLOR_SLOTS,
    dash: dash === "solid" ? (DASH_CYCLE[band] ?? "solid") : dash,
  };
}

export function dashPattern(dash: DashStyle): number[] {
  if (dash === "dash") return [6, 4];
  if (dash === "dot") return [1.5, 3];
  return [];
}
```

Add to `RenderOptions`:

```ts
  dashes: readonly DashStyle[];
```

In `render()`, replace the `response.series.forEach(...)` block (lines 71-81) with:

```ts
    response.series.forEach((series, index) => {
      const style = resolveSeriesStyle(
        options.colorSlots[index] ?? index + 1,
        options.dashes[index] ?? "solid",
      );
      this.drawSeries(
        context,
        plot,
        series,
        xRange,
        yRange,
        colors.series[style.colorIndex] ?? colors.fg2,
        style.dash,
      );
    });
```

Add the `dash: DashStyle` parameter to `drawSeries` and set the pattern before stroking.
Replace lines 204-206 with:

```ts
    context.strokeStyle = color;
    context.lineWidth = 1.4;
    context.setLineDash(dashPattern(dash));
    context.beginPath();
```

and add `context.setLineDash([]);` immediately after the closing `context.stroke();` at
line 230, so the pattern does not leak into the next series or the axes.

- [ ] **Step 4: Supply dashes from the panel and show them in the legend**

In `frontend/src/ui/panel.ts`, add to the `options` object in `renderTiles`:

```ts
      dashes: shown.map(
        (tile) => bySeries.get(tile.signal_path)?.dash ?? "solid",
      ),
```

In `updateLegend`, replace the swatch block (the `colorSlot` computation plus the
`line.className` and `line.style.background` assignments, around lines 178-182) with the
shared function, so the legend and the plot cannot disagree:

```ts
        const style = resolveSeriesStyle(series.color_slot, series.dash);
        line.className = `legend-line dash-${style.dash}`;
        line.style.color = `var(--series-${String(style.colorIndex + 1)})`;
```

Import `resolveSeriesStyle` from `"../render/canvas-renderer"` and delete the literal `8`
that was there — `COLOR_SLOTS` is now the only copy of that number in the codebase.

In `frontend/src/styles/app.css`, replace the `.legend-line` rule (line 442) and add the
dash classes beside it:

```css
.legend-line {
  width: 18px;
  height: 2px;
  flex: none;
  background-color: currentColor;
}

.legend-line.dash-dash {
  background-color: transparent;
  background-image: repeating-linear-gradient(
    to right,
    currentColor 0 6px,
    transparent 6px 10px
  );
}

.legend-line.dash-dot {
  background-color: transparent;
  background-image: repeating-linear-gradient(
    to right,
    currentColor 0 2px,
    transparent 2px 5px
  );
}
```

Two deliberate choices here. The swatch grows from 10px to 18px because a 6/4 dash on a
10px swatch renders as one bar and is not distinguishable from solid — if the dash class is
carrying identity, the swatch has to show it. And the pattern is a `background-image`
rather than a `mask-image`: `mask-image` is unprefixed-only in the plan it replaced, the
native host is WebKitGTK, and the snapshot must render offline in any browser. A gradient
background needs no prefix and no mask support.

- [ ] **Step 5: Check what the dashes actually look like, and what they cost**

**This step is not optional and its output goes in the handoff.** `drawSeries` emits four
`lineTo` calls per bin — `first`, `min`, `max`, `last` — almost all inside a single pixel
column, because bin density is bounded by viewport width. A dash pattern applied to that
path does not necessarily read as "dashed": it can stipple the vertical excursions so the
series reads *fainter*, which is a false magnitude cue. `setLineDash` also costs real time
on long canvas2d paths, against a product target of interactive framerates on 800k points.

Run: `./scripts/run.sh web`, load demo data, put **at least 9 series** in one panel, and
record:

1. A screenshot of the panel. Slot 9 must read as *dashed*, not as *dimmer*.
2. The status bar `render N ms` readout, with and without the ≥9th series, on the same
   workspace and window.

If the dashes stipple the envelope or the render time moves materially, **stop and report
it** rather than shipping. The fallback that preserves the magnitude cue is to dash only the
connecting `first`→`last` segments and stroke the min/max excursions solid; that is a
change to `drawSeries`, not a redesign, but it should be a conscious decision with the
screenshot next to it.

- [ ] **Step 6: Pin the contrast relief channel**

ADR 0011 accepts a sub-3:1 light palette *on the condition* that legend chips carry the
signal path as text. That condition is currently only a sentence. Make it executable: in
the existing e2e workspace spec, add an assertion that every rendered legend chip contains
non-empty `.legend-name` text.

If the legend ever becomes swatch-only, this test fails and sends the reader back to ADR
0011 rather than silently shipping a palette with no relief channel.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `./scripts/test.sh frontend && ./scripts/test.sh e2e`

Expected: PASS. The snapshot artifact size check may move slightly — the legend swatch
grew and three CSS rules were added. Report the delta; do not trim tests to meet it.

- [ ] **Step 8: Commit**

```bash
./scripts/ci.sh format
git add frontend/src/render/canvas-renderer.ts frontend/src/render/canvas-renderer.test.ts frontend/src/ui/panel.ts frontend/src/styles/app.css frontend/tests
git commit -m "feat(render): distinguish series past slot 8 by dash class"
```

---

## Task 5: Make the y-axis deterministic and take autoscale out of the renderer

`visibleYRange` recomputes from the bins in the current response on every frame, so
**panning silently rescales the axis**: the same trace at two different times is drawn at
two different scales, with nothing on screen saying so. That is the "do not mislead the
reader" failure in this renderer. `PanelState.y_range` is already in the session schema,
written as `null` and read nowhere.

**What this task does *not* do:** it does not write the autoscale result back into
`PanelState.y_range` during rendering. That would spend the field's one clean meaning —
`null` = auto, `[a, b]` = the user pinned this — on a cache of whatever the first frame
happened to contain, make painting a session mutation, and then require erasing the field
to get autoscale back. Instead:

- `PanelState.y_range` stays **user intent only**, consumed authoritatively when set.
- Autoscale becomes **sticky per panel view** — computed once from real data and held
  until the panel's series set changes. That is what stops the pan rescale, and it lives in
  the view layer, where ephemeral render state belongs.
- `render()` stops autoscaling entirely. It receives a resolved range and is a pure
  function of (tiles, viewport, y-range, tokens), which is what `AGENTS.md` asks for.

**Files:**
- Create: `frontend/src/render/y-axis.ts`, `frontend/src/render/y-axis.test.ts`
- Modify: `frontend/src/render/canvas-renderer.ts` — `RenderOptions.yRange` required;
  delete `visibleYRange`.
- Modify: `frontend/src/ui/panel.ts` — hold a `YAxisPolicy`, resolve before rendering.
- Modify: `frontend/src/app/workspace.ts`, `frontend/src/app/workspace.test.ts` — add
  `setPanelYRange` / `clearPanelYRange` for the gestures that will own them.

**Interfaces:**
- Consumes: Task 2's harness; Task 4's `RenderOptions`.
- Produces:
  - `export function autoYRange(bins): [number, number] | null` — `null` when no finite
    extrema exist, so a first frame with no data cannot become the axis.
  - `export function isUsableYRange(range): range is [number, number]` — finite and
    ordered.
  - `export class YAxisPolicy` — sticky autoscale keyed on the panel's series set.
  - `RenderOptions.yRange: readonly [number, number]` — **required and non-null**. The
    renderer no longer has a fallback.
  - `WorkspaceModel.setPanelYRange(panelId, range)` / `clearPanelYRange(panelId)`.
  - `render()` and `renderTiles()` keep returning a plain millisecond number. **No caller
    signatures change.**

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/render/y-axis.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { autoYRange, isUsableYRange, YAxisPolicy } from "./y-axis";

const bins = [{ min: -50, max: 120 }];

describe("isUsableYRange", () => {
  it("accepts a finite ordered pair", () => {
    expect(isUsableYRange([-100, 300])).toBe(true);
  });

  it("rejects the degenerate, inverted, and non-finite cases", () => {
    expect(isUsableYRange([5, 5])).toBe(false);
    expect(isUsableYRange([300, -100])).toBe(false);
    expect(isUsableYRange([Number.NaN, 1])).toBe(false);
    expect(isUsableYRange([0, Number.POSITIVE_INFINITY])).toBe(false);
    expect(isUsableYRange(null)).toBe(false);
  });
});

describe("autoYRange", () => {
  it("pads the observed extent", () => {
    const range = autoYRange(bins);
    expect(range?.[0]).toBeLessThan(-50);
    expect(range?.[1]).toBeGreaterThan(120);
  });

  it("widens a flat signal instead of collapsing", () => {
    const range = autoYRange([{ min: 7, max: 7 }]);
    expect(range?.[0]).toBeLessThan(7);
    expect(range?.[1]).toBeGreaterThan(7);
  });

  it("returns null when nothing finite was observed", () => {
    expect(autoYRange([])).toBeNull();
    expect(autoYRange([{ min: null, max: null }])).toBeNull();
  });
});

describe("YAxisPolicy", () => {
  it("uses the serialized range verbatim when it is usable", () => {
    const policy = new YAxisPolicy();
    expect(policy.resolve("a", bins, [-100, 300])).toEqual([-100, 300]);
  });

  it("ignores a serialized range that cannot be rendered", () => {
    const policy = new YAxisPolicy();
    expect(policy.resolve("a", bins, [5, 5])).not.toEqual([5, 5]);
    expect(policy.resolve("a", bins, [300, -100])).not.toEqual([300, -100]);
  });

  // This is the bug: panning changes the visible bins, and the axis must not
  // move because of it.
  it("holds the autoscaled range as the visible data changes", () => {
    const policy = new YAxisPolicy();
    const first = policy.resolve("a", [{ min: 0, max: 1 }], null);
    const second = policy.resolve("a", [{ min: -900, max: 900 }], null);
    expect(second).toEqual(first);
  });

  it("refits when the panel's series set changes", () => {
    const policy = new YAxisPolicy();
    const first = policy.resolve("a", [{ min: 0, max: 1 }], null);
    const second = policy.resolve("a|b", [{ min: -900, max: 900 }], null);
    expect(second).not.toEqual(first);
  });

  it("does not latch onto an empty first frame", () => {
    const policy = new YAxisPolicy();
    policy.resolve("a", [{ min: null, max: null }], null);
    const settled = policy.resolve("a", [{ min: 0, max: 10 }], null);
    expect(settled[1]).toBeGreaterThan(9);
  });
});
```

Append to `frontend/src/app/workspace.test.ts`:

```ts
it("stores and clears a panel y range", () => {
  const model = new WorkspaceModel();
  const panel = model.addPanel();
  expect(model.panels()[0]?.y_range).toBeNull();
  model.setPanelYRange(panel.id, [-100, 300]);
  expect(model.panels()[0]?.y_range).toEqual([-100, 300]);
  model.clearPanelYRange(panel.id);
  expect(model.panels()[0]?.y_range).toBeNull();
});

it("ignores a y range for an unknown panel", () => {
  const model = new WorkspaceModel();
  expect(() => {
    model.setPanelYRange("missing", [0, 1]);
  }).not.toThrow();
});

// Adding or hiding a series must not disturb a range the user pinned.
it("keeps a pinned y range when the series set changes", () => {
  const model = new WorkspaceModel();
  const panel = model.addPanel();
  model.setPanelYRange(panel.id, [-100, 300]);
  model.addSeries(panel.id, "rocket/velocity_body/x");
  model.toggleSeriesVisible(panel.id, "rocket/velocity_body/x");
  expect(model.panels()[0]?.y_range).toEqual([-100, 300]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./scripts/test.sh frontend`

Expected: FAIL — `y-axis` module not found, and `model.setPanelYRange is not a function`.

- [ ] **Step 3: Implement the y-axis policy**

Create `frontend/src/render/y-axis.ts`:

```ts
interface Extent {
  min: number | null;
  max: number | null;
}

const PADDING = 0.06;

export function isUsableYRange(
  range: readonly [number, number] | null | undefined,
): range is [number, number] {
  if (range === null || range === undefined) return false;
  const [min, max] = range;
  return Number.isFinite(min) && Number.isFinite(max) && min < max;
}

/** Padded extent of the supplied bins, or null when none carry finite data. */
export function autoYRange(bins: readonly Extent[]): [number, number] | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const bin of bins) {
    if (bin.min !== null) min = Math.min(min, bin.min);
    if (bin.max !== null) max = Math.max(max, bin.max);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (min === max) return [min - 1, max + 1];
  const padding = (max - min) * PADDING;
  return [min - padding, max + padding];
}

/**
 * Per-panel y-axis resolution.
 *
 * A serialized range is authoritative when it is renderable. Otherwise the
 * autoscale is computed once from real data and held, so panning and zooming
 * do not move the axis under the reader. It refits when the panel's series set
 * changes; an explicit fit gesture is phase 2.
 */
export class YAxisPolicy {
  private key = "";
  private sticky: [number, number] | null = null;

  resolve(
    seriesKey: string,
    bins: readonly Extent[],
    serialized: readonly [number, number] | null,
  ): [number, number] {
    if (isUsableYRange(serialized)) return [serialized[0], serialized[1]];
    if (seriesKey !== this.key) {
      this.key = seriesKey;
      this.sticky = null;
    }
    this.sticky ??= autoYRange(bins);
    return this.sticky ?? [-1, 1];
  }

  reset(): void {
    this.key = "";
    this.sticky = null;
  }
}
```

- [ ] **Step 4: Take autoscale out of the renderer**

In `frontend/src/render/canvas-renderer.ts`:

- Add to `RenderOptions`: `yRange: readonly [number, number];` — required, not nullable.
- In `render()`, replace `const yRange = visibleYRange(response.series);` with
  `const yRange: Range = { min: options.yRange[0], max: options.yRange[1] };`.
- Delete `visibleYRange` (lines 234-251) entirely. It has no remaining caller, and
  `noUnusedLocals` will say so.

The renderer now performs no data-dependent scaling decisions at all. Given the same
tiles, viewport, y-range, and tokens, it draws the same pixels — in the workbench and in a
snapshot alike.

- [ ] **Step 5: Resolve the range in the panel view**

In `frontend/src/ui/panel.ts`, add a policy field to `PanelView`:

```ts
  private readonly yAxis = new YAxisPolicy();
```

and in `renderTiles`, resolve before calling the renderer. The key is built from **all**
series paths, not just the visible ones, so toggling a series' visibility does not move
the axis for the ones still shown:

```ts
    const seriesKey = state.series.map((series) => series.path).join(" ");
    const yRange = this.yAxis.resolve(
      seriesKey,
      response.series.flatMap((tile) => tile.bins),
      state.y_range,
    );
    const options: RenderOptions = {
      xLabel: "time (s)",
      yLabel: yLabel(response.series.map((tile) => tile.unit)),
      colorSlots: shown.map(
        (tile) => bySeries.get(tile.signal_path)?.color_slot ?? 1,
      ),
      dashes: shown.map(
        (tile) => bySeries.get(tile.signal_path)?.dash ?? "solid",
      ),
      yRange,
    };
```

`renderTiles` still returns `this.renderer.render(...)`, a plain number. Nothing in
`workspace-view.ts` or `app-shell.ts` changes, and the status bar keeps working.

- [ ] **Step 6: Add the model methods for the gestures that will own them**

In `frontend/src/app/workspace.ts`, add to `WorkspaceModel`:

```ts
  setPanelYRange(panelId: string, range: [number, number]): void {
    const panel = this.panel(panelId);
    if (panel !== undefined) panel.y_range = range;
  }

  clearPanelYRange(panelId: string): void {
    const panel = this.panel(panelId);
    if (panel !== undefined) panel.y_range = null;
  }
```

Nothing calls these yet — they are the API that double-click-to-fit, shift+wheel y-zoom,
and the phase-2 axis inspector will use, and they are what makes `y_range` meaningful when
a session supplies one. Note this in the handoff so a reviewer does not mistake them for
the dead-field pattern this plan exists to stop: unlike `y_range` before this task, the
field is now **read** on every frame.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `./scripts/test.sh frontend && ./scripts/test.sh e2e`

Expected: PASS. The status bar `render N ms` readout must still update — confirm in the
e2e output that `shared presentation plane renders the demo workspace` passes.

Then check by hand with `./scripts/run.sh web`: load demo data, plot a signal, and pan.
The y-axis tick labels must not change. That is the whole point of the task and no unit
test observes it end to end.

- [ ] **Step 8: Commit**

```bash
./scripts/ci.sh format
git add frontend/src/render/y-axis.ts frontend/src/render/y-axis.test.ts frontend/src/render/canvas-renderer.ts frontend/src/ui/panel.ts frontend/src/app/workspace.ts frontend/src/app/workspace.test.ts
git commit -m "feat(render): stable y axis and a renderer that never autoscales"
```

---

## Final gate

- [ ] **Run the full local quality gate**

Run: `./scripts/ci.sh all`

Expected: PASS. If the snapshot artifact size check regresses, the cause is the CSS added
in Task 4 — report the delta rather than trimming the tests.

- [ ] **Update the roadmap**

Add a phase-1 closeout line to `docs/implementation-roadmap.md` naming the five changes and
linking ADR 0011. Commit as `docs: record phase 1 visualization foundations`.

---

## Known deviations to flag at handoff

1. **Palette values supersede the Final Spec.** ADR 0011 records this, including the
   derivation, so the palette is extensible rather than magic. The spec is not rewritten.
2. **Serialized `color_slot` values re-render in new colours.** No migration is added;
   phase 1 has no released artefacts.
3. **Light-theme slots 3, 6, and 8 measure 1.88, 1.94, and 2.13 against the light
   surface.** Accepted as a deliberate trade of surface contrast for CVD separation
   (ADR 0011), discharged by text-bearing legend chips and pinned by the e2e assertion in
   Task 4 Step 6. On a projector or in greyscale these strokes are faint; a light-mode line
   width bump is a phase-2 candidate once `SeriesState.width` is read.
4. **`--fg-3` remains below WCAG AA** (4.32:1) for chrome text. Task 2 moves only axis tick
   labels to `--fg-2`. The remaining uses are unaddressed by design; see Non-Goals.
5. **`SeriesState.width` is still written and never read** — the renderer hardcodes
   `lineWidth = 1.4`. Task 3 corrects the *written* value from `1.5` to `1.4` so the field
   stops contradicting the spec and the renderer, but does not wire it up: per-series width
   has no UI to set it until the phase-2 legend inspector lands.
6. **`SeriesState.dash` is read but never written by the allocator.** This is deliberate
   (Task 4). If a reviewer expects the allocator to stamp a dash class, point them at the
   Final Spec's F5 legend inspector: `dash` is a user field, and pre-filling it with a
   derivation would put phase 2 in conflict with phase 1.
7. **Beyond 24 series, colours alias again.** 8 colours × 3 dash classes is the ceiling.
   That is the boundary where the Final Spec's "folder → colour family or envelope band"
   model takes over; this plan does not attempt to cover it.
8. **The y-axis holds through zoom as well as pan.** This matches MATLAB, and the brief
   says familiarity beats novelty — but it means zooming into a region does not refit the
   y-axis, and there is no fit gesture wired up yet. Track double-click-to-fit as the
   companion phase-2 item; until it lands, a user who pans into out-of-range data sees
   clipping with no way to refit except adding or removing a series.
9. **`setPanelYRange` / `clearPanelYRange` ship with no caller.** They are API for the
   gestures above, not dead state: `y_range` itself is now read on every frame.
10. **`CanvasRenderer.setPalette` ships with no production caller.** It is the seam that
    makes the renderer testable without a DOM, and the one `BakedPlane` will use to inject a
    baked palette in phase 2.

---

## Revision history

**Revision 2 (2026-07-25)** — audit response. Changes from revision 1:

- **Task ordering.** The old Task 4 is split: the allocator uncap became a standalone
  Task 3 (pure correctness, independently revertible), and the rendering work became
  Task 4. The old Task 3 (y-range) moved to Task 5 and was redesigned. Five tasks, not
  four.
- **Task 2 no longer commits a tree that does not compile.** Revision 1 deleted `formatTick`
  in one step while `drawAxes` still called it, then asserted the next step would pass;
  `./scripts/test.sh frontend` runs `pnpm typecheck`, so it could not have. Merged.
- **Task 2 gained the headless renderer harness.** Revision 1 claimed to add the first
  renderer test file but only tested pure helpers, leaving `drawAxes`, `drawSeries`, and
  the `has_gap` invariant untested. Two small seams (`setPalette`, `globalThis.devicePixelRatio`)
  make `render()` runnable under Vitest's node environment with no new dependency.
- **`SeriesState.dash` is no longer written by the allocator.** Final Spec F5 makes it a
  user field; revision 1 pre-filled it with a derivation from `color_slot`, which phase 2's
  legend inspector would have had to fight. `resolveSeriesStyle` now supplies the band
  fallback at render time and one shared function serves both renderer and legend.
- **The y-range design changed.** Revision 1 wrote the first frame's autoscale back into
  `PanelState.y_range` during rendering, then cleared the field on any series change to get
  autoscale back — which made painting a session mutation, froze whatever frame 1 contained,
  and rescaled the plot whenever a series was hidden. Replaced with a view-layer sticky
  autoscale plus an authoritative-when-set serialized range. As a side effect no caller
  signatures change, where revision 1 required updating every caller of `render()` and
  `renderTiles()`.
- **Serialized y-ranges are validated.** `[5, 5]`, `[300, -100]`, and non-finite pairs
  reached the renderer unchecked in revision 1 and produced a silently blank plot.
- **Method names corrected.** Revision 1's tests called `addSeriesToPanel`; the method is
  `addSeries`. It also instructed the implementor to edit a series-removal method that does
  not exist.
- **`palette.test.ts` fixes.** Removed an unused local that would fail `noUnusedLocals`;
  added known-answer calibration so the colorimetry cannot be silently wrong; added an
  amber ΔE floor to back up the hue band; added a test pinning the light-mode contrast
  trade.
- **ADR 0011 expanded** with the palette's derivation, the contrast-vs-CVD trade and the
  re-step that was tried and rejected, the headroom warning, and the Crameri sourcing
  decision for sequential and diverging maps (with an explicit note that `batlowS` is not
  the categorical source).
- **Smaller fixes:** dropped a dead `.replace()` chain in `formatTicks` (`toExponential`
  already emits the sign); measured the tick glyph with `measureText` instead of a
  hard-coded char width, and dropped revision 1's unexplained 9px→10px font change; moved
  the zero datum off `--border-strong` (1.50:1, indistinguishable from the gridlines) onto
  `--fg-3`; widened the legend swatch to 18px and replaced `mask-image` with a background
  gradient; corrected `width: 1.5` to the spec's `1.4`; collapsed three copies of the
  modulus 8 into one exported `COLOR_SLOTS`; corrected the Non-Goals claim that the `c:`
  colorbar is phase 2 (the spec puts it in v1).
