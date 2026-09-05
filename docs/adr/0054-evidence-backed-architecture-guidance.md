# ADR 0054: Evidence-backed architecture guidance

- Status: Accepted
- Date: 2026-09-05
- Amends: [ADR 0002](0002-layer-boundaries.md), [ADR 0053](0053-module-boundaries-and-shared-primitives.md)
- Clarifies: [ADR 0052](0052-typed-plot-families-and-explicit-x-line2d.md)

## Context

The modularization review found that the construction guide described intended
boundaries as implemented facts, while some accepted instructions contradicted
each other. More files and interfaces did not establish ownership, runtime
validation, bounded work, or reusable semantics. Future implementations need a
decision procedure that exposes those questions without requiring a large
design exercise for every local change.

## Decision

### Give each document one job

- `AGENTS.md` carries the short execution rules and reading route.
- `architecture.md` describes current owners, contracts, dependency crossings,
  and placement guidance. Distinguish enforced rules from review-only rules
  and intended changes.
- ADRs record decisions, alternatives, consequences, and explicit amendments.
  Add a top-level pointer when a later record changes an earlier instruction;
  dates alone do not establish which parts remain authoritative.
- The roadmap owns pending work and observable completion criteria. Reviews
  are dated evidence, not additional normative specifications.
- The Final Spec remains authoritative for visuals and interaction. This
  decision does not change the product's UI requirements.

When code and a decision disagree, record the discrepancy before extending the
affected path. Code establishes current behavior; it does not silently repeal
an accepted invariant. Resolve ordinary implementation details locally. A
change to an accepted boundary needs an explicit ADR amendment, not an implied
exception hidden in a helper or completion report.

### Specify the decision before the abstraction

For changes to architectural boundaries, persistence, reduction semantics, or
resource policy, use the [template](template.md) to record:

1. One concrete use case and a measurable or observable acceptance criterion.
2. The owner of state/invariants, inputs/outputs, and allowed dependencies.
3. The smallest viable alternative, including retaining the current design,
   and why the selected approach is preferable.
4. Affected compatibility domains and captured offline behavior.
5. For asynchronous/resource-owning work: publication point, invalidation,
   cancellation versus ignored results, cleanup, lock scope, and resource cost.
6. Evidence that can reject the design: behavior tests, conformance fixtures,
   or a representative benchmark. Label missing evidence and assumptions.
7. The implementation status and a concrete trigger for revisiting the choice.

Use only relevant sections and keep local changes local. A pure helper
extraction need not produce another ADR. No new registry, service framework,
dependency-injection system, or crate split follows from this decision.

### Judge boundaries by ownership

An extraction should own an invariant, a coherent behavior, or a resource
lifetime. One consumer is sufficient if the seam is independently testable.
Passing the entire previous owner through a new interface does not establish
a boundary. Prefer narrow values/callbacks and direct imports from defining
modules. Keep cross-module behavior tests at the integration boundary where
appropriate; do not move them solely to satisfy a file-size target.

ADR 0002's five-module dependency sketch is historical. The current guide names
the storage primitives and the server/application concentrations that now
exist. A future crate extraction requires review of visibility and public
types; it is not assumed mechanical. No inward dependency on HTTP or desktop
state is introduced or permitted by this clarification.

ADR 0053's 1,000-line restriction still applies after a partial extraction.
There is no automatic exemption for `workspace.ts` or for a module waiting on
a second plot family. Extract the relevant behavior into a cohesive owner
before adding it. If that is inappropriate, an amendment must identify the
specific module, allowed scope, reason, and next review trigger. Small fixes
and documentation corrections do not require unrelated mass decomposition.

### Reuse semantics, not names

ADR 0052's typed families remain the extension policy. Presentation reads for
captured plots require live/baked behavior; nullable live-operation ports do
not require artificial offline implementations. `PreparedPlot`, legend ports,
and window caches are current reuse candidates, not mandatory interfaces for
all future coordinate or reduction systems. A second concrete consumer
determines any broader abstraction.

Generated types are not runtime validators. Protocol, session, preferences,
and snapshot compatibility are reviewed separately. Cancellation of work is
distinct from preventing stale publication. Retained-data limits are distinct
from peak in-flight memory. Guidance must preserve these distinctions.

## Alternatives considered

- **Keep a directory diagram and file-size checklist.** Cheap, but it already
  failed to represent runtime imports, state ownership, and lifecycle costs.
- **Enforce strict layers immediately with a new framework or crate tree.**
  Would expand the review into a broad implementation rewrite without proving
  which existing crossings cause harm. Targeted enforcement is roadmap work.
- **Require a full design document for every change.** Creates duplicated
  guidance and obstructs small fixes. The short template applies to durable
  architectural choices only.

## Consequences and status

This decision defines guidance, not a new runtime framework. Import rules,
core policy extraction, query lifetimes and parser validation are implemented
under [ADR 0055](0055-core-policy-and-query-lifetimes.md). Resource measurements
and remaining UI decomposition stay on the roadmap until their completion
criteria are met.

Future handoffs report what changed, which contracts were checked, what ran,
and which evidence is still missing. A rule is called enforced only when a
named check rejects a violation. Revisit this process when a second concrete
plot family exposes a missing decision, or when a documented invariant escapes
review and tests.
