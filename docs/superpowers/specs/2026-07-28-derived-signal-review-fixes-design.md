# Derived signal review fixes

## Scope

Resolve the derived-signal integrity issues raised during review without
changing the expression language or session schema.

## Backend integrity

The native data state records the signal references for every materialized
derived definition. Replacing or deleting a derived signal is rejected when
another derived definition references it. The error names the dependent paths.
This rule is enforced in Rust so every caller receives the same behavior.

Signal ownership is determined by `Signal.source_id`, never by its path.
Replacement and removal proceed only when the existing signal belongs to the
synthetic derived source. An ingested signal such as `derived/value` therefore
cannot be removed or overwritten through derived commands.

## Quick transforms

Generated names include the full source path flattened with underscores:
`imu/x` becomes `derived/imu_x_dot`, while `gps/x` becomes
`derived/gps_x_dot`. Non-alphanumeric runs are normalized to one underscore so
the result remains lowercase snake_case.

Expressions quote the original path with the existing `quoteSignalPath`
helper. Apostrophes and other supported path characters therefore round-trip
through the MATLAB-style expression syntax.

## Workspace cleanup

After the backend confirms explicit deletion, the workspace removes the path
from every tab:

- plotted series and their annotations;
- XY x axes and signal-backed colour channels;
- favorites; and
- the derived definition itself.

The normal layout-refresh and autosave funnel then serializes the cleaned
state.

## Versioning and tests

The branch is already synchronized at `0.7.0`, satisfying the earlier minor
version review comment. These review fixes finish with a patch bump to `0.7.1`.

Focused Rust tests cover ownership and dependent replacement/deletion.
TypeScript tests cover unique quick-transform names, path quoting, and complete
workspace cleanup. The final verification is `./scripts/ci.sh all` followed by
`./scripts/version.sh check`.
