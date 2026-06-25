# Behavior Contract Inventory

Use this file when a plan touches existing behavior. Build the inventory
**before** the behavioral equivalence analysis.

## Purpose

The behavioral equivalence dimensions in
`references/behavioral-equivalence-analysis.md` cannot be classified honestly
until the current contract is written down. Without that contract, equivalence
reasoning anchors on memory and can silently invent prior behavior.

The inventory makes that contract explicit and pins each entry to an evidence class.

## Three Buckets

Every change that touches existing behavior must produce these three buckets,
each populated separately:

1. **Immediate observable behavior**
   - Inputs, outputs, return values, visible state changes, and user-facing
     effects of the operation.
   - Includes documented contracts: API response shape, command output, UI
     rendering, error messages.
   - Excludes anything that is not directly observable to the caller.
2. **Internal state transition**
   - What the operation does to the source object, container, surrounding cache,
     or in-memory context.
   - Mutation patterns, ownership transfers, observer/subscriber notifications,
     intermediate flag flips, and reentrancy expectations.
   - Includes ordering relationships against neighboring state changes when they
     affect downstream consumers.
3. **Persistent / lifecycle behavior**
   - What survives across persistence round-trips, process restart, reload,
     cache invalidation, garbage collection, or migration.
   - On-disk schema, serialized envelope, identity keys, version markers,
     cleanup obligations, and reload-time reconstruction.
   - Includes packaging or release-path behavior when the change crosses a build artifact boundary.

## Evidence Discipline

Each inventory entry must carry exactly one of:

- `Primary source` — official documentation, vendor docs, upstream code, or
  user-supplied source material that describes the contract.
- `Local investigation` — observed by reading local code, running a
  non-mutating check, or reproducing behavior in this workspace.
- `Unproven` — not yet verified. The entry is recorded so the gap is visible,
  but it must be triaged like any other `Unproven` item with impact, `Phase
  relevance`, fastest proof path, and revisit trigger.

Do not paste the inventory as one paragraph. Keep the three buckets separated
and labeled, even when one bucket is short.

## How to Use the Inventory

- Treat the inventory as the **input** to the equivalence dimensions in
  `references/behavioral-equivalence-analysis.md`. Each dimension classification
  (`Equivalent`, `Changed (in scope)`, `Not applicable`, `Unknown`) must be
  defensible against the inventory rows that touch it.
- When a dimension would be classified `Equivalent` against a bucket entry that
  is still `Unproven`, the dimension is `Unknown`, not `Equivalent`.
- When the inventory has no entry for a dimension that the change clearly
  affects, that is a missing inventory entry, not a free pass to skip the
  dimension.
- When a `must preserve` dimension is contradicted by an inventory entry, stop
  and report to the user. The discovery is a stop signal, not a
  reclassification opportunity.

## Replacement and Restoration

When the request replaces, restores, rolls back, or rewrites behavior, the inventory has two columns:

- The **historical / known-good** contract for each bucket.
- The **current** contract for each bucket.

Compare them before describing the replacement plan. If the historical contract
for a bucket cannot be sourced from `Primary source` or `Local investigation`,
mark that bucket as `Unproven` for the historical column and treat the gap as a
recovery blocker per `references/change-recovery-checklist.md`.

## Output Requirement

The inventory must appear in the plan output before the behavioral equivalence
analysis. Internal consideration alone is not sufficient. The equivalence table
that follows must visibly cite or align with inventory rows.

For a `light` plan, the inventory may be compact (one or two lines per bucket)
but the three buckets must still be labeled. Do not emit empty bucket headings
to satisfy structure. The inventory may be omitted entirely **only** when the
current slice provably does not touch existing behavior, and the omission must
record an evidence-backed not-applicable rationale (e.g. `Local investigation`:
confirmed by reading source that the slice introduces a new code path with no
existing-behavior intersection). Refactors, migrations, and internal
implementation changes count as touching existing behavior under `SKILL.md`
high-risk planning controls and stay under this inventory rule even when every
row collapses to `Not applicable`.
