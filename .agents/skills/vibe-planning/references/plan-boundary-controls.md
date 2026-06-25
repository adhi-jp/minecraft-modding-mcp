# Plan Boundary Controls

Use this file before finalizing a plan or after incorporating review feedback.
It controls what belongs in the main plan body, what must be deferred, and when
plan iteration must stop.

## Why this exists

Plans bloat predictably:

- Review notes are pasted in verbatim instead of being classified.
- Success criteria grow one bullet at a time without a recorded basis.
- Implementation details creep in before the test contract is locked.
- Past plan revisions are repeated as history instead of folded into a current
  decision.

Each failure is recoverable if the plan body is treated as a typed surface, not
a free-form notebook.

## Plan-Content Classification

Classify every candidate addition as exactly one of:

| Class | Definition | Where it goes |
| --- | --- | --- |
| `spec-level` | Goal, success criteria, scope, behavior contract, ambiguity, deferred decision. | Main plan body. |
| `proof-level` | Verified facts, evidence labels, `Unproven` triage, recommended proof path. | Main plan body. |
| `test-level` | Acceptance tests, regression tests, proof checks, behavioral-equivalence tests. | Main plan body. |
| `impl-detail` | Pseudocode, control flow, variable names, function signatures, code-shape sketches. | Defer unless required to prove feasibility for the current slice or to define a current-slice test. |
| `history-only` | Past plan revisions, prior review feedback already actioned, narration of how the current plan was reached. | Collapse into a short rolling summary, or omit when it does not change a current decision. |

When an addition would fall into more than one class, classify it as the more
restrictive class, which is the one further down the table.

### `impl-detail` exception

`impl-detail` may enter the main plan only when one of the following is true and
recorded inline:

- The detail is the **proof of feasibility** for the current slice (a primitive, API, or syntactic form whose existence is what makes the slice possible).
- The detail is **needed to write the test** that locks the current slice (the test cannot be specific without naming a function, signature, or invariant).

Cosmetic improvements, such as variable rename, section reorder, or prose
polish, do not qualify under either exception.

### `history-only` collapse

Past revisions belong in the commit/PR record, not in the plan body. When history is genuinely load-bearing for a current decision, summarize it in one or two lines (e.g., "Prior revision treated session histories as evidence; reframed in this revision because they are inaccessible from this workspace") and link the actual record outside the plan.

## Success Criteria Freeze

Once the current-slice success criteria are written, they are **frozen** for that slice.

A success-criteria addition is admissible only when it cites at least one of:

1. A new or restated **user requirement** (quote or paraphrase the user's instruction, with conversation reference).
2. A newly **verified source** (`Primary source` or `Local investigation`) that surfaces a constraint the original criteria missed.
3. A **`must preserve` dimension** in `references/behavioral-equivalence-analysis.md` that turned out to be non-equivalent (per the stop-and-report path in that file).

Inadmissible bases include "review suggested it", "this would also be nice", "for completeness", "while we are here", or any phrasing that does not point at one of the three sources above. Such suggestions go into deferred decisions or `Risks and unproven items` with recorded impact, `Phase relevance`, fastest proof path, and revisit trigger — not into the success criteria.

When a `must preserve` dimension reclassification triggers a success-criteria
expansion, **automatically escalate to a `strict` plan** and record the
reclassification basis next to the new criterion.

## Diagnostic-Finding Restraint

When the plan responds to diagnostic findings, review comments, audit output, or
analyzer warnings, treat each finding as a bounded input:

1. Map the finding to the smallest change that would make that exact finding false.
2. Check whether an existing contract already covers the issue and only needs clearer placement, wording, or cross-reference.
3. Defer adjacent hardening, detector expansion, new operating modes, additional fixture families, and new policy surfaces unless the finding explicitly requires them or a newly verified source proves the narrow correction cannot work.
4. Record any deferred adjacent work as a deferred decision, not as part of current-slice success criteria.

If a reviewer later asks for one of the deferred adjacent items, run it through the Success Criteria Freeze again. "A reviewer found a related concern" is not enough by itself.

## Completion Gate

Plan iteration stops, and the report is delivered, when **all of the following are true for the current slice**:

- Zero `Unproven` items with `Phase relevance: current-slice implementation blocker` remain. Risk level (`low` / `medium` / `high` / `critical`) does not on its own exempt an item — only a deferred or non-implementation `Phase relevance` admits an `Unproven` item under this gate.
- The behavior contract inventory (when applicable) is complete with evidence labels.
- The behavioral equivalence analysis (when applicable) classifies every dimension; no dimension is `Unknown`.
- The applicable failure-pattern checklist sections from `references/failure-pattern-checklist.md` are cleared, AND the applicability record (per the same file's §Applicability Record) is present so non-selected adjacent categories are visible. A missing or unjustified non-selection fails this gate.
- Success criteria are frozen and cite an admissible basis for every entry.
- Tests, proof checks, or acceptance criteria for the current slice are specific enough to implement against.

The completion gate **does not override the `Unproven` stop rule.** Any `Unproven` item with `Phase relevance: current-slice implementation blocker` keeps the plan in the `implementation is blocked` stop condition, regardless of risk level and regardless of how many other gates pass. Clearing the gate marks the plan as ready for review and possible handoff to implementation; it does not authorize implementation around an open blocker.

The gate is also **not a budget for adding more detail**. Once the gate passes, do not extend the plan with `impl-detail`, additional speculative options, or fresh review-driven success criteria. Stop.

## Plan-Body Firewall

Before emitting a final plan output, walk every addition introduced since the previous plan version through this firewall:

1. Classify the addition (`spec-level`, `proof-level`, `test-level`, `impl-detail`, `history-only`).
2. If it is `impl-detail`, verify the exception condition; otherwise defer with a one-line note.
3. If it is `history-only`, collapse or drop.
4. If it touches success criteria, run it through the freeze rule and either admit it or move it to deferred items.
5. If the completion gate passes, stop adding material.

Record the firewall pass implicitly by the resulting plan shape — do **not** emit a meta-section enumerating each rejection unless the rejections are themselves a deliverable the user asked for.

## Mode Restraint

In a `light` plan, the firewall still applies, but it does not require the plan
to expand. A `light` plan that already meets the completion gate should not gain
new sections from a review pass; surface only the blockers that actually
changed.

In a `strict` plan, every addition is scrutinized against the freeze rule, and
`impl-detail` exceptions must be cited inline.
