# ADR 0034: Declarative container recipes

- Status: Accepted
- Date: 2026-08-03
- Amends: [ADR 0002](0002-layer-boundaries.md), [ADR 0009](0009-ingest-jobs-and-progress.md), [ADR 0023](0023-global-preferences-file.md), [ADR 0033](0033-format-provider-registry.md)

## Context

HDF5 and Parquet files can contain arbitrary dataset layouts.
Adding a Rust decoder for every layout is not practical, but sidecar files are
untrusted input and must never select executable code. Recipes also need stable
cache and session identity when a layout changes.

## Decision

Native ingest exposes read-only HDF5 and Parquet container readers behind the
`ContainerReader` boundary. A recipe is a versioned TOML data model containing
only a closed container kind, dataset selectors, time sources, names, and units.
Every recipe struct denies unknown fields, the container kind is a closed enum,
and selectors reject absolute paths, parent traversal, and NUL bytes. Recipes
cannot name a plugin, decoder, command, executable, or path outside the
container. A nesting-exhaustive test pins the unknown-field rule at every
recipe and time-source level.

Container limits are part of the trust boundary: readers cap group depth,
dataset count, and declared materialized size, and enumerate hard links only.
Recipes cannot reach outside a container because readers refuse external links;
selector validation alone is not the containment guarantee.

Resolution checks `<source>.scope.toml` first, then sorted TOML files in the
configured user recipe directory. A malformed recipe is an error rather than a
reason to fall through to another recipe. A resolved recipe registers a runtime
provider with id `recipe:{id}` and a cache ABI derived from its content digest.

The normalized recipe digest is recorded in the source session record and in
cache provenance. Restore fails a changed or missing recipe with an actionable
reconfirm or relink result; it does not silently decode the source with a
different layout. Registration remains transactional, so a failed recipe
decode leaves no source or partial signals visible.

Container readers, recipes, and providers remain native ingest concerns. They
never reach the frontend renderer or a baked snapshot. The import wizard may
request a bounded native outline and save a validated recipe through the
protocol, but it cannot parse or execute one in the presentation plane.

## Consequences

Users can describe common project layouts without a Rust change, and semantic
recipe edits invalidate the affected cache. Recipe files are portable data,
but a recipe is intentionally tied to its container kind and the source's
recorded digest. MATLAB-specific layouts and live sources remain unsupported
until separate reader seams are accepted.
