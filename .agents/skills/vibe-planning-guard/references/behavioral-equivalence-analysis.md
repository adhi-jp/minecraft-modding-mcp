# Behavioral Equivalence Analysis

Use this file when a change touches existing behavior, regardless of whether the change is intended to preserve, modify, or replace that behavior.

## When to Apply

Apply this analysis to **any change that touches existing behavior**, including replacement, refactoring, migration, internal implementation change, and explicit specification change.

This analysis is not limited to changes that claim to preserve contracts. Even when the user explicitly requests a behavior change, other dimensions may be unintentionally affected.

The following are **not** valid reasons to skip this analysis:

- "The new code uses the same API as the old code."
- "The user requested this specific change, so other dimensions are fine."
- "The immediate output looks the same."

## Scope Separation

Before classifying dimensions, separate each into one of two scopes:

- **In scope for change**: The user's request or requirements explicitly allow this dimension to change. Requires a clear, traceable basis in the user's stated requirements.
- **Must preserve** (default): Every dimension not explicitly marked as in scope for change. When in doubt, classify as must preserve.

Do not classify a dimension as in scope for change without an explicit basis in the user's requirements. "It seems reasonable to change this" is not sufficient.

## Dimension Classification

Classify every dimension with exactly one of:

- **`Equivalent`** — Verified by `Primary source` or `Local reproduction`. Expected classification for `must preserve` dimensions.
- **`Changed (in scope)`** — Allowed only for `in scope for change` dimensions, and only when all of the following are present:
  1. The user's request explicitly places this dimension in scope for change.
  2. Changed success criteria are documented.
  3. A test for the new behavior exists.
  - If any of these are missing, classify as `Unknown` instead.
- **`Not applicable`** — This dimension does not apply to the operation being changed. Requires a short rationale with an evidence class (example: "This operation handles in-memory-only values that are never persisted. — `Local reproduction`: confirmed by reading source.").
- **`Unknown`** — Not yet verified. Treat as `Unproven` and resolve before implementation.

### When a Must Preserve Dimension Is Not Equivalent

If analysis reveals that a `must preserve` dimension is not equivalent:

1. **Stop and report to the user.** State that this dimension was not explicitly in scope for change but is not equivalent.
2. Do not self-classify the difference as intentional or acceptable. The discovery of a non-equivalent `must preserve` dimension is a stop signal.
3. If the user approves reclassifying the dimension to `in scope for change`, update the classification to `Changed (in scope)` and provide the required success criteria and test.
4. When any `must preserve` dimension is reclassified to `in scope for change` during analysis, **automatically escalate to strict mode** and update the plan's success criteria to reflect the expanded scope of change.

## Comparison Dimensions

For each operation being changed, compare old and new implementations across these nine dimensions:

1. **Immediate observable result** — Output, return value, or visible state change.
2. **Ownership and reference semantics** — Does the operation move, copy, alias, or create? Does it transfer ownership or produce a new independent instance?
3. **Internal state changes** — What happens to the source object, container, or context after the operation? Is it consumed, marked, hidden, or left unchanged?
4. **Side effects and events** — Does the operation fire events, send notifications, write logs, update counters, or trigger observers? Do the side effects match?
5. **Persistence and serialization** — If the affected state is saved and reloaded, does the result survive identically? Are there dangling references, orphaned copies, or duplicate entries after a round-trip?
6. **Lifecycle and reload behavior** — What happens on process restart, session reconnect, context reload, cache invalidation, view reconstruction, or garbage collection?
7. **Error and edge cases** — What happens with invalid input, missing prerequisites, concurrent access, partial failure, or resource exhaustion? Do failure modes match?
8. **Resource cleanup and disposal** — Does the replacement leave the same cleanup obligations? Are there leaked resources, unclosed handles, or orphaned state?
9. **External contracts and guarantees** — Consumer-visible wire contracts (API response structure, event schemas), execution ordering guarantees, input validation rules, authorization and access control behavior, idempotency, atomicity, consistency guarantees, rate limiting, and retry semantics.

Not every dimension applies to every change. Use `Not applicable` with a rationale for irrelevant dimensions, but do not skip classification.

## Surface Equivalence Warning

When the new code has a similar API name, similar parameter shape, or similar immediate output to the old code, treat this as a **risk signal** rather than evidence of equivalence.

Before classifying a dimension as `Equivalent`:

- Read the implementation or documentation of both old and new code to understand internal behavior, not just the input/output contract.
- For each dimension, identify at least one way the old and new implementations could plausibly differ.
- If you cannot identify any plausible difference for a dimension, state that explicitly as a verified claim with evidence, not as an assumption.

## Output Requirement

The equivalence analysis must appear in the plan output. Internal consideration alone is not sufficient.

Once this analysis has been performed for a change, the analysis section must remain in the output regardless of subsequent mode changes, scope reclassification, or any other plan updates.
