# ADR NNNN: Concrete decision title

- Status: Proposed | Accepted | Superseded by ADR NNNN
- Date: YYYY-MM-DD
- Amends / supersedes: Link affected records and name the changed rule, or omit.

Use this template for durable architectural decisions. Remove prompts and
irrelevant sections; a local implementation choice does not need an ADR.

## Context

What concrete use case or failure requires a decision? Link the relevant code
or measurement. What observable result establishes success? State scope and
non-goals, especially when preparing for an unimplemented feature.

## Decision

Name the state and invariant owner, inputs/outputs, and dependencies. Describe
one request or state transition through the boundary. Explain why existing
primitives do or do not fit. Avoid creating hypothetical consumers.

For async/resource work, identify publication, invalidation, cancellation,
cleanup, lock scope, and peak cost. For API/persistence work, identify the
version domain, defaults/migration, failure behavior, and offline semantics.

## Alternatives and tradeoffs

Compare the smallest viable alternative, including retaining current behavior.
Explain the chosen tradeoff, costs, and conditions that would reverse it.

## Validation

Name behavioral tests, shared conformance cases, or representative benchmarks
that could disprove the decision. State inputs and expected outcomes; mark
unmeasured assumptions explicitly. Link existing evidence without claiming
planned tests have passed.

## Consequences and implementation status

Separate accepted policy from landed code. Link pending work to the roadmap
with its completion criterion; keep rolling progress there. State the next
review trigger. Update affected ADR pointers and the construction guide.
