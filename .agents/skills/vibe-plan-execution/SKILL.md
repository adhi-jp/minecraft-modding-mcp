---
version: 3.3.0
name: vibe-plan-execution
description: Use when the user asks to execute, implement, continue, or apply an existing implementation plan, specification, acceptance criteria, task plan, or prior planning output. Do not use for plan creation or coding requests with no concrete plan to bind.
---

# Vibe Plan Execution

## Overview

Execute an existing implementation plan without inventing missing behavior. Bind
to the plan, verify the facts it depends on, implement the smallest safe current
slice, and stop when reality contradicts the plan.

Questioning a plan is required when its sections conflict or implementation
reveals a defect. The plan is authority for scope and intent, not proof that
every implementation instruction is correct. Deviating from it is not allowed
until verified evidence proves the plan is incorrect, stale, impossible, unsafe,
or already satisfied. Treat "this looks redundant" as a hypothesis, not as
permission to skip planned API, specification, implementation, or test work.
When the defect changes the requirements, acceptance criteria, proof strategy,
or implementation contract, return to the owning requirements or planning
artifact before editing that behavior. Do not turn a stale plan into a series of
one-off patches.

If no concrete plan exists, return to planning before coding. A prior planning
workflow can produce a valid plan, but no specific workflow is a prerequisite
for this skill.

## Plan Sources

This skill executes any concrete bound implementation plan. The plan may come
from a planning workflow, a hand-written specification, an issue, a task list,
or an inline plan supplied by the user.

Planning workflows that write a Markdown plan artifact and return only a short
user-facing summary need one extra check. For any plan source, when a local plan
file path is available, read and bind to that file before using any pasted
summary or conversation recap. When the plan has these sections, read them
directly:

- `Goal`, `Requirements`, and `Acceptance criteria` define the behavior
  contract for the current slice.
- `Verified facts and sources` is reusable plan evidence. Re-check workspace
  facts that may have changed since planning; plan-authored `Local
  investigation` must become current `Local evidence` before implementation
  relies on it.
- `Test plan` defines the first verification path unless local evidence shows it
  is stale or insufficient.
- `Skill usage plan`, when present, defines per-step route intent. Bind it,
  verify the relevant skill availability in the current environment before use,
  and keep the plan's fallback when a route is unavailable.
- `Behavior contract inventory`, `Behavioral equivalence analysis`,
  `Failure-pattern checks`, `Plan integrity gates`, and recovery sections define
  high-risk contract constraints when present.
- `Implementation plan` defines the edit order and proposed means; do not add
  adjacent work. When an implementation step conflicts with higher-level
  requirements, acceptance criteria, non-goals, safety constraints, or verified
  local reality, treat that as a plan defect instead of implementing it blindly.
- `Implementation progress`, when present, is the durable resume ledger. Read it
  before choosing the current item, reconcile it with the implementation plan
  and commit checkpoints, and treat completion claims as stale until current
  `Local evidence` confirms the item status.
- `Risks and unproven items` and `Proceed condition` decide whether coding
  starts, stays conditional, or returns to planning.

If the bound plan says implementation is blocked, do not start coding. If it is
conditional on proof or accepted risk, perform the proof first or restate the
accepted risk before touching affected code.

Treat user-facing summaries as navigation aids, not as complete implementation
contracts. If a summary conflicts with the referenced plan artifact, bind to the
artifact and surface the conflict before editing when it affects scope,
behavior, verification, risk, or proceed conditions.

## Concrete Plan Requirements

A plan is concrete enough to execute only when the current slice has:

- A goal and user-visible outcome.
- In-scope and out-of-scope behavior.
- Acceptance criteria or equivalent pass/fail checks.
- A test, proof, or manual verification path.
- Implementation steps or a named code area to inspect first.
- Open risks, unproven items, or a statement that none are known.

A referenced summary alone is not concrete enough when it points to an
accessible plan artifact. Read the artifact first. If the path is missing,
unreadable, outside permitted access, or ambiguous, ask for the plan content or a
corrected local path instead of implementing from the summary.

If any missing item changes what to build, how to test it, data handling,
permissions, external contracts, or user experience, return to planning instead
of inventing the gap.

## When Not to Use

Do not use this skill for:

- Creating the initial plan, specification, acceptance criteria, or test plan.
- Rough coding requests where the user has not supplied or referenced a plan.
- General code explanation, debugging advice, or tiny edits with no plan context.
- Planning-review work where the right output is a revised plan rather than code.

## Core Rules

- Identify the implementation plan before editing files. If the user references
  a local plan file path, read it before editing. If multiple plans could apply,
  ask the user which one is authoritative.
- Treat the user's words as intent, not verified fact. Check implementation
  claims against the plan, local code, tests, configs, logs, schemas, and
  official documentation before relying on them.
- The bound plan remains authoritative for scope, acceptance criteria,
  non-goals, risk, and required verification even when it seems redundant,
  inefficient, overly broad, or simplifiable. It is not a shield for known-bad
  implementation details. Only `Local evidence` or `Primary source`
  verification can prove that a planned step may be skipped, reordered,
  narrowed, corrected, or replaced.
- Do not implement outside the plan's behavior contract unless the Plan
  Deviation Gate has passed and the user explicitly agrees. A Plan Validity
  Gate correction that preserves the existing goal, requirements, acceptance
  criteria, non-goals, and safety/data/permission/security/UX constraints is not
  outside-plan work. When an unplanned change appears necessary, explain the
  reason, impact, and closest plan-preserving alternative first.
- If plan sections conflict, give priority to the user-visible behavior
  contract: explicit safety/security/data constraints, `Acceptance criteria`,
  `Requirements`, and non-goals outrank lower-level implementation steps,
  helper choices, checkpoint messages, or planning notes. Do not implement a
  lower-level step that would violate the higher-level contract.
- Treat a user follow-up that names a concrete failure mode as implementation
  evidence to verify, not as automatic scope creep. Do not reject it merely
  because the current implementation follows the plan text. Re-check the plan,
  local code, tests, current diff, and relevant primary sources, then either
  correct within the existing contract or stop for a plan-changing decision.
- A verified plan-changing defect starts a requirements or plan revision loop,
  not an ad hoc implementation patch. Identify the owning artifact: return to
  requirements-spec work when user-visible behavior, scope, data handling,
  permissions, security posture, UX, external contracts, or acceptance criteria
  are wrong; return to implementation planning when the goal is still correct
  but the plan's proof strategy, test strategy, edit order, implementation
  surface, or risk handling is wrong. Resume execution only after a revised
  artifact or replacement plan contract is bound.
- Missing commit authorization is not a generic implementation blocker for a
  plan that has no planned history operation. When the plan's proceed condition
  and the user's instruction to execute or implement the plan allow
  implementation but do not authorize commits, implement and verify the ready
  slice, then stop before staging, committing, or other history mutation.
- A plan-authored `Commit checkpoints` section or "commit after each slice"
  instruction is scoped local-commit authorization for those checkpoints when
  the user asks to execute, implement, apply, or continue that bound plan, unless
  the current user instruction or project policy denies commits. Do not stop only
  to ask for another "commit" instruction at each planned checkpoint. This
  authorization does not cover push, release preparation, version bumps, amend,
  reset, stash, squash, destructive operations, external side effects,
  work-in-progress commits, unverified commits, or checkpoint scope changes.
- A release step, destructive operation, external side effect, delegated
  execution request, or other user-consent boundary is different: it is a
  consent-bound plan item. If exact authorization is missing, run the Startup
  Consent Preflight before editing the affected slice. Do not implement through
  later slices hoping to reconstruct consent decisions from a larger mixed diff.
- A user request to skip planned verification, API, specification, test, or
  implementation work is a plan-change request, not evidence. Verify first or
  stop for a planning update when the skipped work affects correctness, data,
  permissions, external contracts, security, or UX behavior.
- Preference for a smaller diff, local style, architectural taste, speed,
  memory, or "this should be enough" is never a valid reason to deviate from
  the plan.
- Do not silently "fix" an incorrect or impossible plan. State the conflict with
  evidence, propose a viable adjustment, and wait when the decision changes
  product behavior, data handling, security, cost, schedule, or user experience.
- For non-technical users, explain blockers and choices in practical terms.
  Prefer concrete options such as "keep the original scope" or "expand the plan
  to include account permissions" over abstract architecture language.
- When a non-technical user is unsure about behavior the bound plan already
  marks out of scope, do not turn that uncertainty into a blocker. State that
  the behavior is outside the current plan and continue the current slice
  without it, unless the user explicitly asks to change the plan scope.
- Prefer the repository's existing patterns and the smallest change that satisfies
  the current slice. Do not overfit to minimalism when the plan requires a
  broader but clearly bounded change.
- Bound high-risk planning sections are execution contract, not background.
  Behavior inventories, equivalence dimensions, known-good recovery evidence,
  diagnostic-scope limits, success-criteria freezes, plan-body firewall
  outcomes, and selected failure-pattern checks constrain implementation and
  verification.
- If the bound plan leaves a current-slice implementation assumption
  `Unproven`, do not implement that slice unless the plan records an explicit
  `Accepted risk` for the conditional step. Risk level by itself never clears
  an `Unproven` implementation blocker.
- When the bound plan is a writable local artifact, update only its
  `Implementation progress` section as execution state changes. Mark the active
  item `In progress` before meaningful edits when doing so is safe, then update
  the item after verification, post-implementation review, blocking evidence,
  approved skips, and any authorized checkpoint commit. Do not edit scope,
  requirements, acceptance criteria, tests, risks, or implementation steps as a
  "progress update"; those changes require the owning artifact revision loop.
- If a writable artifact-backed plan has multiple implementation items or
  commit checkpoints but lacks an `Implementation progress` section, initialize
  a minimal ledger from the already-bound implementation steps and checkpoint
  scopes before or immediately after locking the current item. Use `Not started`
  for unverified items and preserve the plan's scope text; do not add new work,
  new acceptance criteria, or proposed commit messages while creating the
  ledger.
- A progress update is evidence-backed status, not proof by itself. Use statuses
  such as `Not started`, `In progress`, `Completed`, `Blocked`, or `Skipped with
  approved deviation`, and include the verification command or manual check
  result, review disposition, commit action if any, remaining blocker, and next
  item. Do not mark an item `Completed` when verification was skipped, failing,
  unavailable, or only self-reported by delegated output.

## Evidence Classes

Use these labels internally and in user-facing blockers, questions, plan
deviation notices, commit-checkpoint decisions, and execution summaries when
they affect scope, behavior, verification, risk, commit authorization, or
whether implementation may proceed:

- `Plan`: stated by the bound implementation plan, specification, acceptance
  criteria, or task list.
- `Local evidence`: verified in the current workspace by reading code, tests,
  configs, schemas, logs, or running relevant checks.
- `Primary source`: official documentation, authoritative specifications,
  upstream source, vendor docs, or user-provided source material.
- `Accepted risk`: an `Unproven` item explicitly accepted in the bound plan or
  by the user for the active request, with impact and revisit trigger preserved.
- `Unproven`: memory, inference, unchecked user claims, secondhand summaries, or
  assumptions not yet backed by the plan, local evidence, or a primary source.

Implementation steps may rely only on `Plan`, `Local evidence`, or `Primary
source`. `Accepted risk` may support only the conditional steps that the plan
already tied to that risk. Convert all other `Unproven` items into proof work,
questions, or blockers.

Do not omit evidence labels only because no files were edited. A refusal,
request for clarification, commit-message correction, or "proceed with this
slice" response still needs labeled evidence when the decision depends on the
plan or on checked facts.

## Execution Gates And Delegation Reference

Before deviating from a bound plan, correcting a plan defect, crossing a consent
boundary, or delegating execution or review work, read
`references/execution-gates-and-delegation.md`. That reference owns the Plan
Deviation Gate, Plan Validity Gate, Startup Consent Preflight, and Delegated
Execution Support rules.

## Execution Workflow, Review, And Quality Reference

Before executing a bound plan slice, launching post-implementation review,
updating the implementation-progress ledger, communicating completion or
blockers, or applying final quality checks, read
`references/execution-workflow-and-quality.md`. That reference owns the
detailed execution loop, post-implementation review gate, stop-condition
handling, user communication details, ledger updates, commit-checkpoint
handling, and quality checklist.
