# Automated Demo Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate the README demo GIF and a hosted live demo from the shipping
export path on release, so both track the product instead of going stale.

**Architecture:** `./scripts/demo.sh` runs bake, record, encode, and publish.
Bake calls the existing `./scripts/export.sh` with the demo's fixed arguments;
no new baking logic. Record drives the baked `demo.html` through a Playwright
`demo` project isolated from the e2e gate. Encode converts Playwright's WebM to
GIF with `ffmpeg`. Publish force-pushes an orphan `gh-pages` commit so no binary
enters main's history.

**Tech Stack:** Bash wrappers, Playwright 1.57, `ffmpeg` from the pinned flake,
Node ESM check scripts, GitHub Actions.

**Design source:** [Automated Demo Artifacts Design](../specs/2026-07-27-automated-demo-artifacts-design.md)

## Dependency Status

The design's hard dependency is satisfied. `./scripts/export.sh` and
`core/scope-core/src/bin/scope-bake.rs` bake a manifest into the
`#signalscope-baked-data` slot, and `snapshot::plan` with `--range all` bakes
every signal in the store, so the baked demo's signal tree carries all 16
`demo_flight.csv` signals and any of them can be plotted interactively.

## Global Constraints

- Every CI shell command calls a `./scripts/` wrapper. `./scripts/demo.sh` is
  the only supported entry point for the pipeline.
- Bake adds no export logic. It passes fixed arguments to `./scripts/export.sh`.
- The demo bakes `examples/demo_flight.csv` unchanged.
- Artifacts regenerate on release only. Pull requests gain no recording time and
  no binary churn.
- The demo spec must not run in `./scripts/test.sh e2e`, `./scripts/ci.sh e2e`,
  or `./scripts/coverage.sh`.
- Add no frontend runtime dependency; `ffmpeg` is a dev-shell tool only.
- Anchor the recording on selectors the e2e suite already exercises: `.panel`,
  `.workspace-row`, `.panel-split-right`.
- Preserve unrelated worktree changes and stage only intentional files.

## Resolved Ambiguities

**Starting state.** The bake passes no `--workspace`, so the demo opens on the
default session and the recording plots signals from the tree, as the design's
sequence specifies. Consequence: the hosted live demo lands on an empty
workspace that the visitor populates. If the landing page should instead open
pre-populated, that is a follow-up adding a committed
`examples/demo.signalscope` and a `--workspace` flag to the bake stage — out of
scope here.

**Formula bar.** `BakedPlane.derived` is `null`, so `app-shell` hides the
formula toggle in a snapshot. The demo cannot show derived signals. Keep the
sequence to tree plotting, zoom, split, and tab switching.

**GIF ceiling.** Start at 4 MB and ratchet down to the measured size plus ten
percent once Task 1 produces a real number, mirroring how
`frontend/scripts/check-snapshot.mjs` pins 750 KB.

**No ADR.** This is CI, tooling, and documentation. It changes no architecture,
protocol, or schema, and the design direction is already approved.

---

### Task 1: Spike canvas video capture

The design rests on an unverified assumption: that Playwright video capture
records canvas content. Prove it before building anything else.

**Files:**

- Modify: `flake.nix`
- Temporary: a throwaway spec under `frontend/tests/demo/`

- [ ] **Step 1: Add `ffmpeg` to the dev shell**

Add `ffmpeg` to the `devShells.default` package list in `flake.nix`. It belongs
in the shared list, not `linuxTauriPackages` — encoding is not Linux-specific.

- [ ] **Step 2: Verify the flake still evaluates**

Run: `./scripts/ci.sh flake`

Expected: pass, and `ffmpeg -version` resolves inside `./scripts/dev.sh`.

- [ ] **Step 3: Bake a demo snapshot by hand**

Run:

```bash
./scripts/export.sh --data examples/demo_flight.csv \
  --range all --fidelity full --out build/demo/demo.html
```

Expected: `build/demo/demo.html` exists and contains
`id="signalscope-baked-data"`.

- [ ] **Step 4: Record a throwaway sequence and inspect the frames**

Write a minimal spec that loads the baked `file://` URL, plots one signal, and
waits a few seconds, with `video: "on"`. Encode it and open the GIF.

Expected: plotted strokes are visible in the frames. Playwright records
compositor output, so canvas content should appear.

**If canvas content is blank:** stop and escalate. Every remaining task depends
on this. Record the finding in the design doc and evaluate
`page.screenshot()` frame stitching as the fallback encode input before
continuing.

- [ ] **Step 5: Record the measured GIF size**

Note the byte size from a 15-second, 800 px, 12 fps encode. It sets the Task 5
ceiling.

- [ ] **Step 6: Delete the throwaway spec**

Leave only the `flake.nix` change. Task 3 writes the real spec.

### Task 2: Isolate a Playwright demo project

**Files:**

- Modify: `frontend/playwright.config.ts`
- Modify: `frontend/package.json`
- Modify: `frontend/knip.json`

**Interfaces:**

- Produces: Playwright project `demo` with `testDir: "./tests/demo"`
- Changes: `pnpm e2e` becomes `playwright test --project=desktop`
- Produces: `pnpm demo` runs `playwright test --project=demo`

- [ ] **Step 1: Scope the existing e2e script to the desktop project**

Change `"e2e"` to `playwright test --project=desktop` in
`frontend/package.json`. This is the load-bearing edit: `playwright test` runs
every project by default, so without it the new `demo` project would join the
e2e gate, `./scripts/coverage.sh`, and `./scripts/test.sh full`.

- [ ] **Step 2: Add the demo project and script**

Add to `projects` in `frontend/playwright.config.ts`:

```ts
{
  name: "demo",
  testDir: "./tests/demo",
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 800 },
    video: { mode: "on", size: { width: 1280, height: 800 } },
  },
  outputDir: "../build/demo/recording",
}
```

A fixed viewport keeps the encode's scale deterministic. A fixed `outputDir`
makes the WebM findable from `demo.sh` without parsing a reporter. Add
`"demo": "playwright test --project=demo"` to `frontend/package.json`.

- [ ] **Step 3: Skip the dev server for the demo run**

The demo loads a `file://` baked artifact, so the `webServer` block is pure
overhead and fails in a CI job that never installed a dev host. Gate it:

```ts
webServer:
  process.env.SIGNALSCOPE_DEMO === "1"
    ? undefined
    : { command: "pnpm dev", url: "http://127.0.0.1:4173", reuseExistingServer: !process.env.CI },
```

`demo.sh` sets `SIGNALSCOPE_DEMO=1`.

- [ ] **Step 4: Register the demo directory with knip**

Add `"tests/demo/*.ts"` to `entry` in `frontend/knip.json`. `project` already
covers `tests/**/*.ts`, so without the `entry` addition
`pnpm --filter @signalscope/frontend check:unused` reports the new spec as
unused and the quality gate fails.

- [ ] **Step 5: Confirm the e2e gate is unchanged**

Run: `./scripts/test.sh e2e`

Expected: pass, running only the desktop project. The demo spec directory does
not exist yet, which is fine — nothing selects it.

### Task 3: Script the demo sequence

**Files:**

- Create: `frontend/tests/demo/demo.spec.ts`

**Interfaces:**

- Consumes: `build/demo/demo.html`
- Produces: `build/demo/recording/**/*.webm`

- [ ] **Step 1: Write the sequence**

Load the baked artifact from `build/demo/demo.html` as a `file://` URL, the same
way `frontend/tests/e2e/snapshot-roundtrip.spec.ts` reaches its artifacts. Then:

1. Plot two or three signals from the tree.
2. Zoom into a region.
3. Split a panel right via `.panel-split-right`.
4. Plot a contrasting signal into the new panel.
5. Add a workspace tab and switch to it.

Assert the outcome of each step before pausing, so a UI change that breaks the
sequence fails loudly rather than recording a video of nothing. Use
`.workspace-row`, `.panel`, and the legend selectors the e2e suite already
relies on.

- [ ] **Step 2: Pace the sequence for video**

Insert deliberate waits between steps. Test-speed interaction is unreadable as
video. Keep the total under 15 seconds of wall clock so the encode fits the
size ceiling; a shared `beat()` helper of roughly 900 ms keeps the pacing in one
place.

- [ ] **Step 3: Assert no network requests**

Mirror the roundtrip spec's request listener. The demo is a self-contained
snapshot and must stay one, and this catches a regression in the hosted
artifact before it ships.

- [ ] **Step 4: Run the recording against the Task 1 bake**

Run: `cd frontend && SIGNALSCOPE_DEMO=1 pnpm demo`

Expected: pass, with exactly one `.webm` under `build/demo/recording/`.

### Task 4: The `./scripts/demo.sh` wrapper

**Files:**

- Create: `scripts/demo.sh`
- Modify: `AGENTS.md`

**Interfaces:**

- Produces: `./scripts/demo.sh [all|bake|record|encode|publish <dir>]`
- Produces: `build/demo/demo.html`, `build/demo/demo.gif`

- [ ] **Step 1: Write the wrapper**

Follow the `scripts/export.sh` shape: `set -euo pipefail`, source `lib.sh`,
`ensure_dev_shell "$@"`, a `show_help` heredoc, and a `case` on the mode. Quiet
output, no banners.

`bake` runs:

```bash
"$signalscope_scripts_dir/export.sh" \
  --data examples/demo_flight.csv \
  --range all --fidelity full \
  --out build/demo/demo.html
```

`record` clears `build/demo/recording`, then runs
`SIGNALSCOPE_DEMO=1 pnpm --filter @signalscope/frontend demo`, then resolves the
single `.webm` and fails with a clear message if the count is not exactly one.

`encode` runs the two-pass palette conversion, which matters for the near-black
flat UI:

```bash
ffmpeg -y -loglevel error -i "$webm" \
  -vf "fps=12,scale=800:-1:flags=lanczos,palettegen=stats_mode=diff" \
  -f image2 build/demo/palette.png
ffmpeg -y -loglevel error -i "$webm" -i build/demo/palette.png \
  -lavfi "fps=12,scale=800:-1:flags=lanczos,paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle" \
  build/demo/demo.gif
```

`all` runs bake, record, encode, then the Task 5 check.

`publish <dir>` is Task 6.

- [ ] **Step 2: Document the wrapper**

Add `./scripts/demo.sh` to the canonical command list in `AGENTS.md` under
`./scripts/export.sh`.

- [ ] **Step 3: Run the full pipeline**

Run: `./scripts/demo.sh all`

Expected: `build/demo/demo.html` and `build/demo/demo.gif` exist; the GIF is
under the ceiling and visibly shows plotted signals.

- [ ] **Step 4: Confirm shellcheck passes**

Run: `./scripts/ci.sh quality`

Expected: pass. `quality_checks` runs `shellcheck scripts/*.sh`, which now
covers `demo.sh`.

### Task 5: Artifact checks

**Files:**

- Create: `frontend/scripts/check-demo.mjs`
- Modify: `frontend/package.json`
- Modify: `scripts/demo.sh`

**Interfaces:**

- Produces: `pnpm check:demo`

- [ ] **Step 1: Write the check**

Mirror `frontend/scripts/check-snapshot.mjs`: collect failures into an array and
throw once. Assert that `build/demo/demo.html` contains
`id="signalscope-baked-data"`, holds no `http://` or `https://` URL and no
external `src`/`href` attribute, and that `build/demo/demo.gif` exists and is
within the ceiling. Set `maximumGifBytes` to the Task 1 measurement plus ten
percent, with a comment naming the ratchet, matching how the snapshot budget is
pinned.

- [ ] **Step 2: Wire it up**

Add `"check:demo": "node scripts/check-demo.mjs"` to `frontend/package.json` and
call `pnpm --filter @signalscope/frontend check:demo` at the end of
`demo.sh`'s `all` mode.

- [ ] **Step 3: Verify the ceiling bites**

Temporarily lower `maximumGifBytes` and run `./scripts/demo.sh all`.

Expected: a failure naming the actual and budgeted byte counts. Restore the
real value.

### Task 6: Publish to an orphan `gh-pages` branch

**Files:**

- Modify: `scripts/demo.sh`
- Modify: `scripts/ci-policy.test.sh`

**Interfaces:**

- Produces: `./scripts/demo.sh publish <dir>`

- [ ] **Step 1: Implement `publish`**

Validate that the directory exists and holds both `demo.html` and `demo.gif`;
exit 2 on a usage error and 1 on a missing artifact, matching
`release.sh publish`. Then build a single orphan commit and force-push it, so
no binary ever enters main's history:

```bash
work="$(mktemp -d)"
cp "$asset_dir/demo.html" "$asset_dir/demo.gif" "$work/"
cp "$asset_dir/demo.html" "$work/index.html"
git --work-tree="$work" --git-dir="$signalscope_root/.git" \
  checkout --orphan gh-pages-publish
# stage only the copied artifacts, commit, push --force origin HEAD:gh-pages
```

Prefer explicit `git add -- demo.html demo.gif index.html` over any blanket
add. `index.html` is a copy of the snapshot so the Pages root is the live demo.

- [ ] **Step 2: Cover the failure modes**

Extend `scripts/ci-policy.test.sh` with `expect_status 2` for a missing
directory argument and `expect_status 1` for a staged directory lacking the
GIF, following the existing `release.sh publish` cases. Do not test the push
itself.

- [ ] **Step 3: Verify locally without pushing**

Run the publish path against a temporary directory with a fake `origin` remote
pointed at a local bare clone.

Expected: a `gh-pages` branch on the bare clone with three files and one
commit, and main's history untouched.

- [ ] **Step 4: Run the policy tests**

Run: `./scripts/ci.sh quality`

Expected: pass, including the new cases.

### Task 7: Release job

**Files:**

- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add the `demo` job**

Place it after `tag` and depend on it, so artifacts regenerate on release only —
`release.sh tag` refuses an existing tag, so a `tag` success means a real
release. Give the job read-only contents permission and a checkout without
persisted credentials. Use `./.github/actions/setup` with the Cachix token,
then run `./scripts/demo.sh all` and upload `build/demo` with
`actions/upload-artifact@v4`.

Add a separate `deploy-demo` job after `tag` and `demo`. Give only this job the
`github-pages` environment and Pages write/OIDC permissions. Download the
commit-scoped demo artifact, publish `gh-pages` with
`./scripts/demo.sh publish build/demo`, and deploy the same staged Pages
content.

Leave `ci-ok` alone. The demo job never runs on a pull request, and adding it to
that needs list would make every PR's aggregate gate report a skip.

- [ ] **Step 2: Lint the workflow**

Run: `./scripts/ci.sh quality`

Expected: pass. `quality_checks` runs `actionlint` and
`zizmor .github/workflows/ .github/actions/`, both of which see the new job.

- [ ] **Step 3: Note the manual enablement step**

Publishing succeeds but serves nothing until GitHub Pages is configured to use
GitHub Actions in repository settings. Call this out at handoff; it cannot be
done from the repository.

### Task 8: Documentation

**Files:**

- Modify: `README.md`
- Modify: `docs/implementation-roadmap.md`
- Modify: `docs/superpowers/specs/2026-07-27-automated-demo-artifacts-design.md`

- [ ] **Step 1: Embed the GIF and link the live demo**

Add both near the top of `README.md`, above **Quick start**, for readers who are
skimming:

```markdown
[![SignalScope demo](https://tanged123.github.io/signalscope/demo.gif)](https://tanged123.github.io/signalscope/)

The GIF and the [live snapshot](https://tanged123.github.io/signalscope/) are
generated on release from the product's own export path.
```

The remote URL is correct here: the no-network rule governs the exported
snapshot, not the README.

- [ ] **Step 2: Update the roadmap**

The Phase 4 entry in `docs/implementation-roadmap.md` already anticipates this
work. Mark the demo pipeline delivered and point at this plan.

- [ ] **Step 3: Retire the deferral and the unverified risk**

Change the design doc's status from "deferred to Phase 4" to implemented,
naming this plan. Replace the **Risk** section's "unverified" language with the
Task 1 finding. A design note that still calls its own foundation unverified
after it shipped misleads the next reader.

### Task 9: Final validation and release metadata

- [ ] **Step 1: Format**

Run: `./scripts/format.sh`

Expected: all changed source, workflow, and Markdown files are formatted.
treefmt covers Markdown, so the plan and design edits are formatted too.

- [ ] **Step 2: Run the complete gate**

Run: `./scripts/ci.sh all`

Expected: pass. This is a cross-layer change touching the flake, the Playwright
config, scripts, the workflow, and docs, so the narrow gate is not sufficient.

- [ ] **Step 3: Run the demo pipeline once more end to end**

Run: `./scripts/demo.sh all`

Expected: pass, after the full gate, to confirm nothing in the final state
broke the sequence.

- [ ] **Step 4: Apply the patch version bump**

Run: `./scripts/version.sh bump patch`

Run: `./scripts/version.sh check`

Expected: synchronized version `0.12.2`. Patch is the right class: this is
build, CI, tooling, and documentation. It ships no user-facing application
capability — the demo artifact is a distribution asset, and the frontend and
core behavior it exercises already existed.

- [ ] **Step 5: Re-run format and the affected checks**

Run: `./scripts/format.sh`

Run: `./scripts/ci.sh quality`

Expected: pass.

- [ ] **Step 6: Review and commit only intended files**

Review staged and unstaged diffs separately. Leave `build/demo/` out of the
commit — confirm `.gitignore` covers `build/`. Commit with a conventional
subject and the why.

## Handoff Notes

State at handoff: which commands ran and their results, that GitHub Pages must
use GitHub Actions before the README links resolve, that the first real GIF only
appears after the next release lands on main, and that the hosted demo opens on
the shipping export's empty default session.
