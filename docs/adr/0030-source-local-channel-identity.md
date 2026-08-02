# ADR 0030: Source-local channel identity

- Status: Accepted
- Date: 2026-08-02

## Context

Workspace channel mapping duplicated named sets, obscured source-native signal
names, and added controls and session state without improving plot selection.

## Decision

Channel identity is the pair of source key and source-local channel name.
Named sets provide reusable cross-source grouping. The signal outline groups
equal source-local names for navigation only; it does not create a canonical
channel identity.

Session schema version 18 removes `channel_map`. The v17 migration rewrites
every explicit series reference from a mapped canonical name to that source's
alias before removing the map. Selector strings are unchanged because they are
queries rather than explicit references.

## Consequences

Mapped v17 panels and picked sets retain their source-local signals. Selectors
that relied on a canonical mapped name no longer match differently named
channels and must be replaced with a named set or an explicit selector. The
schema removal is a breaking session API change and requires a major release.
