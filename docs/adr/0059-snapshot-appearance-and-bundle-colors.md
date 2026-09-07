# ADR 0059: Snapshot appearance and bundle color order

- Status: Accepted
- Date: 2026-09-07
- Amends: [ADR 0023](0023-global-preferences-file.md) (offline appearance defaults),
  [ADR 0024](0024-snapshot-manifest-and-export-budget.md) (manifest contents),
  [ADR 0051](0051-style-cascade-and-legend-statistics.md) (bundle color order).

## Context

HTML snapshots retained panel widths and overrides but lost the global stroke
scale, making exports thinner when that scale exceeded 100%. Font preferences
were also lost. Source coloring reused the same hue across separate bundles,
making their focused representatives difficult to distinguish.

## Decision

The protocol owns an optional `preferences_json` field on `ExportWriteRequest`
and `SnapshotManifest`. It carries the existing independently versioned
preferences format, restricted to the schema version, UI and plot fonts and
sizes, and plot line-width scale. `app/preferences.ts` selects these fields;
cache paths, recipe paths and resource settings are excluded. Theme remains in
the session.

The shell captures current appearance at export. The server forwards it into
the manifest before the existing escaped injection and atomic file replacement.
`BakedPlane` exposes the captured JSON alongside its session JSON; the shell
uses the shared preferences parser and applies appearance before mounting plots.
There is no new mutable store, network request, or resource lifetime. Offline
appearance changes remain in memory.

Absent or null fields preserve previous defaults, including CLI exports that
have no user preferences. Malformed or unsupported preferences use the existing
parser fallback. This is an additive protocol change with no session migration
or protocol-version increment. New snapshots embed the matching runtime.

`app/resolution.ts` owns bundle color allocation. Source and focus color rules
start one palette step later for each subsequent nonempty binding in plotting
order. Each bundle retains its own first-appearance sequence. Explicit overrides
still win; flat, channel, set, and attribute rules retain their meanings.
Each large bundle arrival focuses its first member unless a member is already
focused; prior bundles keep their focus. Ghost members remain gray.
Existing serialized binding order reproduces the
allocation in sessions and snapshots; no new color state is stored.

## Alternatives and tradeoffs

Multiplying session widths during export would distort width encodings and
focus emphasis, and can exceed the override schema's range. Capturing the
existing appearance scale preserves the same rendering pipeline. Embedding the
whole preferences file would unnecessarily disclose machine-specific paths.

## Validation

Resolution tests cover bundle order, focused representatives and explicit
overrides. Preferences tests cover appearance round trips and omitted private
settings. HTTP export and injection tests cover manifest preservation, escaping
and absent-field compatibility. Browser snapshot tests cover offline appearance
restoration alongside existing state, no-network and size-budget checks.

## Consequences and implementation status

The manifest, exporter and reader implement the additive capture path. Existing
HTML cannot recover appearance settings that were never captured; re-exporting
from the live workspace includes them. Future appearance fields must be added
deliberately to the capture whitelist and round-trip tests.
