# Phase 3 design: transforms and durable sessions

Covers the roadmap's Phase 3 line: the docked expression bar with history,
prototype-compatible expression semantics, derived signals in the tree, schema
migrations, autosave/recovery, and session round-trip coverage.

The phase splits into two halves that meet at one seam — a derived signal is
defined by an expression, and that definition, not its samples, is what a
session stores. Part A builds the engine; Part B makes it durable.

## Departures from the design handoff

The Final Spec specifies a JavaScript expression dialect: `$("path")`
references, `Math.*` calls, and `deriv`/`integ`/`smooth`
(`design_handoff_signalscope_ui/README.md` line 38). The live formula-bar
placeholder in `frontend/src/ui/app-shell.ts` matches it.

This design uses a MATLAB dialect instead, at the user's explicit direction.
Per `CLAUDE.md`'s conflict order the user's request outranks the design source
of truth. ADR 0008 is amended rather than contradicted: it mandates that
evaluation happen in the native compute layer and forbids JavaScript `eval`,
both of which this design honors. Only the surface syntax changes.

The formula-bar placeholder text changes with it.

## Part A — transforms

### A1. Module layout

`scope-core::compute` keeps the transform primitives and takes MATLAB names,
which is honest rather than cosmetic: each already computes exactly what its
MATLAB counterpart does.

| was          | becomes    | MATLAB semantics already matched                         |
| ------------ | ---------- | -------------------------------------------------------- |
| `derivative` | `gradient` | central differences, one-sided ends, non-uniform `t`     |
| `integrate`  | `cumtrapz` | cumulative trapezoid from zero, non-finite pairs skipped |
| `smooth`     | `movmean`  | centered moving mean, `'omitnan'` behavior               |

`movmean` differs from MATLAB for even window sizes: MATLAB uses
`[i-k/2, i+k/2-1]` while this implementation uses `half = k/2` on both sides,
giving `k+1` samples. Odd windows — the only ones the UI generates — agree
exactly. The spec records the difference rather than changing behavior.

`compute` also regains `lerp_at`, deleted by pre-Phase-3 Task 3 as unreachable.
Cross-timebase resampling needs it again. It must mirror `lerpSample` in
`frontend/src/app/xy.ts`, including NaN outside the sample range, and is locked
by a conformance fixture in the manner of `sample_window`.

A new module `scope-core::expr` holds the language. It depends on `store`,
which is the established inward direction.

```rust
expr::parse(src: &str)                      -> Result<Expr, ExprError>
expr::references(expr: &Expr)               -> Vec<String>
expr::evaluate(expr: &Expr, store: &SignalStore) -> Result<Vec<f64>, ExprError>
```

`parse` and `references` touch no store and are unit-testable in isolation.
`ExprError` carries a byte span so the formula bar can point at the offending
token, and names the nearest match for an unknown identifier.

### A2. The language

A quoted string in value position **is** a signal reference. MATLAB has no
sigil, and signal paths such as `motor/left/velocity` are not valid
identifiers, so quoting carries the whole burden. Both quote styles parse.

```matlab
derived/speed = hypot('imu/vx', 'imu/vy')
derived/jerk  = gradient('derived/speed')
derived/clean = movmean('motor/left/current', 51)
derived/dist  = cumtrapz('gps/speed')
derived/over  = 'batt/temp' > 60              % yields 1 or 0
derived/ramp  = 'cmd/throttle' .* (t >= 10)
derived/mag   = sqrt('imu/ax'^2 + 'imu/ay'^2)
```

Precedence follows MATLAB, lowest to highest. The short-circuit forms bind
_looser_ than the element-wise ones, which is the reverse of the C family:

1. `||`
2. `&&`
3. `|`
4. `&`
5. `<` `<=` `>` `>=` `==` `~=`
6. `+` `-`
7. `*` `/` `.*` `./`
8. unary `-` `+` `~`
9. `^` `.^` — right-associative, binding tighter than unary minus, so `-2^2`
   is `-4`

Every value is a per-sample scalar, so `&` and `&&` compute identically and
`.*` is a synonym for `*`. Both spellings parse because MATLAB users type both;
precedence is what actually differs.

`%` begins a comment that runs to end of line.

Functions: `abs sqrt exp log log2 log10 sin cos tan asin acos atan atan2 sinh
cosh tanh hypot floor ceil round fix sign mod rem min max power`, plus the
three whole-signal ops. Constants: `pi Inf NaN eps`, with `inf` and `nan` also
accepted since MATLAB accepts them. The binding `t` is the sample time.

Comparisons and logical operators yield numeric `1` or `0`. Any comparison
involving NaN yields `0`, as in MATLAB.

Two omissions are deliberate. There is no ternary — MATLAB has none, and
`x .* (t >= 10)` is the idiom. There is no sample-index binding; the prototype
exposes a zero-based `i`, but an index has no meaning once references are
resampled onto a common timebase.

There is no `e` constant, because MATLAB defines none; `exp(1)` is the MATLAB
spelling and is what this language accepts.

### A3. Evaluation

The base timebase is that of the **first** reference in source order. Every
other reference is `lerp_at`-resampled onto it, yielding NaN outside its own
range. This is the prototype's rule, kept unchanged.

Arithmetic evaluates per sample through a scalar walk that allocates no
intermediate arrays. This matters at scale: over a 100M-point signal each
intermediate would cost 800 MB.

The whole-signal ops are the single exception, because `gradient`, `cumtrapz`,
and `movmean` cannot be computed one sample at a time. Each materializes its
argument once, recursively, so a nested expression works:

```matlab
derived/accel = gradient(hypot('imu/vx', 'imu/vy'))
```

The prototype cannot express this — its regex accepts only a bare name inside
those calls. Intermediates therefore appear only where an op genuinely needs
one, and their count is bounded by the number of whole-signal ops in the
expression rather than by its total node count.

### A4. Derived signal lifecycle

Creation evaluates the expression into a full values array, inserts it into
`SignalStore` under one synthetic `derived` source, and builds its pyramid in
memory. Every downstream consumer — tiles, samples, XY, FFT, histogram, stats,
and Phase 4 export — needs no change, because a derived signal is an ordinary
signal from that point on.

Derived pyramids are never written to the sidecar cache. They are always
rebuilt from the expression, which keeps the cache keyed purely by input file
and avoids a second invalidation rule.

Names are required to sit under `derived/`; a name lacking the prefix gains it.
That guarantees the tree group the Final Spec calls for and keeps the derived
namespace from colliding with ingested paths.

Forward references are rejected at creation. A derived signal may reference an
earlier derived signal, but not a later one, so definition order is always a
valid replay order and Part B needs no topological sort.

### A5. Protocol version 5

Two requests, both thin wrappers over `expr`:

```
DerivedRequest      { path: string, expr: string }  -> SignalSummary
RemoveSignalRequest { path: string }                -> ()
```

There is no `validate_expression` request. Pressing ↵ attempts creation and the
bar renders the error, which is what the prototype does and what keeps the
protocol surface honest — a validation call that cannot fail differently from
creation is a second code path to keep in sync for no gain.

`RemoveSignalRequest` rejects paths outside `derived/`; ingested signals are
removed by their source, not individually.

### A6. UI surface

The docked bar already exists as chrome: `.formula-bar`, the `toggle-formula`
command, the `E` key, and a submit handler that only calls `preventDefault()`.
This phase makes it live.

- Input accepts `derived/name = expr`. A bare `expr` with no `=` gets a
  generated `derived/expr_N` name, as in the prototype.
- ↵ creates. On success the bar clears, the tree repopulates, and the new
  signal is added to the focused panel.
- On failure the bar shows the `ExprError` message and highlights the reported
  span. The input keeps its text so the user can correct it.
- ↑ and ↓ walk the history of accepted expressions. History is per-session and
  in-memory; it is not persisted, since a session already stores every
  definition it produced.
- Esc collapses the bar, as today.

The signal tree gains the `derived/` group with amber ƒx marks, per the Final
Spec. Amber is correct here — the handoff lists "ƒx/derived marks" among the
sanctioned interaction-only uses. Each derived leaf offers removal, which
issues `RemoveSignalRequest`.

The legend inspector gains four quick transforms, matching the prototype's
style popover. They emit ordinary expressions through the same create path, so
they carry no separate semantics:

| button | emits                   | name                  |
| ------ | ----------------------- | --------------------- |
| d/dt   | `gradient('<path>')`    | `derived/<short>_dot` |
| ∫dt    | `cumtrapz('<path>')`    | `derived/<short>_int` |
| smooth | `movmean('<path>', 51)` | `derived/<short>_avg` |
| \|x\|  | `abs('<path>')`         | `derived/<short>_abs` |

These are the discoverable entry point; most users will never type an
expression.

### A7. Testing

- Rust unit tests for the lexer and parser covering MATLAB precedence, the
  `-2^2 == -4` case, `%` comments, both quote styles, and unknown-identifier
  errors with their suggested match.
- Rust tests for evaluation: NaN comparison semantics, cross-timebase
  resampling, nested whole-signal ops, and forward-reference rejection.
- A `lerp_at` conformance fixture pairing Rust against `lerpSample`, following
  `protocol/testdata/sample-conformance.json`.
- Transform parity tests locking `gradient`/`cumtrapz`/`movmean` against the
  values the prototype produces for a shared input.
- Playwright coverage for the formula bar: create, error display, history
  recall, and the legend quick transforms.

## Part B — durable sessions

### B1. Session schema version 10

Two new fields on `Session`:

| field          | type              | contents                                  |
| -------------- | ----------------- | ----------------------------------------- |
| `derived`      | `DerivedSignal[]` | `{path, expr}`, in definition order       |
| `source_paths` | `string[]`        | files to re-ingest when the session opens |

Both are required arrays rather than optional fields, so migration arm 9 does
real work: it inserts each as an empty array. This is the case the pre-Phase-3
note distinguished — additive _optional_ fields need no rung because
`#[serde(default)]` covers them, but required fields do.

### B2. Where persistence lives

`scope-core::session` gains `save_to_path` and `load_from_path`. Migration
already lives in that module, so a version-aware read belongs beside it. The
Tauri shell owns only app-data path resolution, staying thin per ADR 0002.

Writes are temp-file-plus-rename. A crash during a write can then never leave a
truncated session behind, which is the substance of calling this recovery.

The frontend debounces, since that is where state changes originate, and Rust
performs the write. Autosave targets `session.autosave.json` in the app-data
directory. Launch calls `load_session(null)` and receives either the autosave
or a default session.

There is no recovery prompt. The application resumes where it was left, which
is the honest behavior and avoids inventing chrome the Final Spec does not
describe.

### B3. Protocol version 5, session half

Session types are generated from `scope-session.json` and protocol types from
`scope-protocol.json` by two independent generators. Rather than couple them,
session IO carries the session as a JSON string inside the protocol envelope.
Rust parses it through `session::from_json`, which migrates. Migration
therefore stays in exactly one place, and the protocol schema gains no
knowledge of session shape.

```
SessionDialogMode  enum { open, save }

SaveSessionRequest { session_json: string, path: string? } -> SavedSession  { path: string }
LoadSessionRequest { path: string? }                       -> LoadedSession { session_json: string, path: string? }
PickSessionRequest { mode: SessionDialogMode }             -> string?
```

A null `path` means the autosave slot; a string means a named workspace file.
`SessionDialogMode` is a schema enum rather than a bare string, matching how
`IngestStage` and `IngestState` are already declared.

### B4. Load orchestration

`load_session` deliberately does not ingest. A blocking multi-GB read inside a
load call is the wrong shape and would violate the streaming-ingest rule. The
frontend drives the sequence instead:

1. Call `load_session`; Rust parses and migrates, failing clearly on an unknown
   future version and never partially restoring.
2. Start one ingest job per `source_paths` entry through the existing job and
   progress API (ADR 0009). The pyramid sidecar cache makes this fast on a
   revisit.
3. Replay each derived definition in order through Part A's `DerivedRequest`.

No new endpoint is needed for replay, and definition order is a valid replay
order because forward references were rejected at creation.

A replay failure is the unresolved case: the definition stays in the session,
no signal is registered, and the affected panel renders the
`unknown signals: …` empty state that pre-Phase-3 Task 13 built for exactly
this. Re-ingesting a missing source resolves it with no further machinery. A
missing source file is reported and its path is retained rather than dropped.

### B5. Theme and chrome

The localStorage theme key is deleted. The session becomes the single durable
store, applied synchronously after `load_session` and before first render. This
closes the three-way divergence the pre-Phase-3 audit recorded, at the moment
its replacement exists.

`Open Workspace…`, `Save Workspace`, and `Save Workspace As…` retire three
`planned` stubs in `app-shell.ts`. `Open Recent ▸` stays planned. The title
strip shows the workspace file name, or `Untitled`, with an unsaved dot.
Because autosave always runs, unsaved means precisely "not yet written to the
named file" — crash safety and explicit saving stay separate concerns.

### B6. Round-trip coverage

This is what makes `WorkspaceModel.snapshot()` load-bearing; it has no
production caller today.

- Rust: the v9-to-v10 migration; a full round trip carrying derived definitions
  and source paths; temp-file-plus-rename behavior; a truncated or corrupt
  autosave failing with an actionable error rather than partially restoring;
  and an unknown future version still rejected.
- A TypeScript-to-Rust conformance fixture asserting that the session JSON each
  side emits parses on the other, in the manner of
  `protocol/testdata/sample-conformance.json`.
- Playwright: create a derived signal, save, reload, and confirm restoration;
  and open a session before its data, confirm the unresolved state, ingest, and
  confirm it resolves.

The Phase 4 exporter will consume this same session JSON, so this phase adds
the fixture rather than the exporter.

## Decision records

- **ADR 0008** gains an amendment recording the MATLAB dialect. Its decision —
  evaluation in the native compute layer, no JavaScript evaluation of user
  expressions — is unchanged; only the surface syntax is restated.
- **ADR 0005** gains an amendment for session schema version 10, covering
  derived definitions and source paths.
- **A new ADR** records durable session persistence: the autosave slot, atomic
  temp-file-plus-rename writes, resume-without-prompt, and the choice to carry
  sessions as JSON strings across the protocol boundary so that the two schemas
  stay independent and migration stays in one module.

## Sequencing

Part A ships first and is independently useful — the expression bar, the
derived tree group, and the legend quick transforms all work within a single
run of the application. Part B then makes that work survive a restart. The only
dependency running the other way is schema v10's `derived` field, which
describes a Part A concept, so the schema bump belongs to Part B.

## Out of scope

Export of HTML, PNG, or CSV; the screenshot matrix; and snapshot size budgeting
are Phase 4. Layout presets, `Open Recent`, and live streaming remain later
work. The determinism seams the pre-Phase-3 plan deferred — `performance.now()`
in render signatures, injectable `devicePixelRatio`, and `crypto.randomUUID()`
annotation ids — are still owed immediately before Phase 4's screenshot work,
not here.
