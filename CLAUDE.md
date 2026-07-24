# SignalScope Claude Code instructions

Read and follow the repository's canonical agent rules in [`AGENTS.md`](AGENTS.md)
before making changes. Those rules apply to Claude Code as well as Codex.

Non-negotiable reminders:

- Use the `./scripts/` wrappers for setup, development, tests, formatting,
  coverage, builds, CI checks, and release preparation. If a needed operation
  lacks a wrapper, add one instead of defaulting to generic tooling.
- Read the design handoff and relevant ADRs before UI, architecture, protocol,
  or data changes. The Final Spec controls visuals; the prototype informs
  behavior; neither is production code.
- Preserve the two-host `DataPlane` architecture, versioned protocol/session
  schemas, tile-pyramid gap/extrema invariants, transactional ingest, and
  self-contained no-network snapshots.
- Preserve user worktree changes and stage only intentional files/hunks. Run
  the affected script plus the appropriate broader CI gate before handoff.

When instructions conflict, follow the user's request, then the design/ADR
source of truth, then `AGENTS.md`; call out the conflict and resulting choice.
