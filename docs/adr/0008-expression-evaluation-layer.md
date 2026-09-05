# ADR 0008: Expressions evaluate in the native compute layer

- Status: Accepted
- Date: 2026-07-24

## Context

Derived-signal expressions could evaluate as sandboxed JavaScript in the
presentation plane or in the native compute module behind the protocol. A
Phase 0 frontend stub parsed `deriv`/`integ`/`smooth`/`$` references and
gate-checked strings with an eval blocklist, while `scope-core::compute`
already implements the same transforms in Rust — seeding both answers.

## Decision

Expression evaluation is a protocol request served by `scope-core`'s compute
module (ADR 0001: the native plane owns compute). The frontend may parse
references for editor affordances but never evaluates. Snapshots bake derived
results like any other signal. The dormant frontend stub — and its blocklist
"sandbox", which pre-committed to in-browser eval — was removed rather than
left as false assurance.

## Consequences

One authoritative implementation of derived-signal semantics. The derived
formula bar remains part of the UI contract and stays inert until the protocol
request exists. No JavaScript evaluation of user expressions runs in the
webview.

## Amendment (2026-07-27, MATLAB dialect)

The expression surface syntax is MATLAB rather than the JavaScript dialect the
Final Spec describes. A quoted string in value position is a signal reference,
so there is no `$` sigil; functions are bare MATLAB names; `^` is power, `~=`
is inequality, `%` starts a comment, and `.* ./ .^` are accepted synonyms. The
three transforms are `gradient`, `cumtrapz`, and `movmean`, which is what they
already computed. Logical expressions yield numeric 1 or 0; there is no ternary
and no `e` constant, because MATLAB has neither.

The decision above is unchanged: evaluation happens in `scope-core`, and no
JavaScript evaluation of user expressions runs in the webview. Only the syntax
the parser accepts has changed.

## Amendment (2026-09-05, bounded expression depth)

Core parsing limits both active recursive expression calls and expression-tree
depth to 128, rejecting excess with `ExprError::TooDeep` before evaluation or
publication. Parentheses, unary operators, powers and function arguments count
toward parser nesting. Left-associated binary chains also count toward tree
depth, protecting recursive reference collection, evaluation and destruction.
Depth is tracked during construction so rejection never has to destroy an
already unbounded tree. Large balanced expressions remain allowed; this is not
a token-count cap or a general compute-memory budget.

This is an input-safety limit, not a protocol/session schema change. Existing
expressions within the limit keep their semantics; deeper saved expressions
now fail clearly on materialization. Parser boundary tests and an authenticated
derived-endpoint test cover rejection without partial publication. Revisit the
limit only with stack measurements or an iterative parser/evaluator design.
