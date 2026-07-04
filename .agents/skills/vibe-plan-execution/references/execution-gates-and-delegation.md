# Execution Gates and Delegation Reference

Read this reference before deviating from a bound plan, correcting a plan defect, crossing a consent boundary, or delegating execution or review work.

## Plan Deviation Gate

Changing planned scope, edit order, proof strategy, test strategy, API or data
contract handling, named implementation surface, or omitting any
correctness-affecting step is a plan deviation. Skipping a planned check because
it appears redundant is a deviation.

Before proposing or taking a deviation, complete all of these steps:

1. Re-read the exact plan item, acceptance criteria, test plan, risks, and
   proceed condition that the deviation would affect.
2. Verify the relevant local code, tests, configuration, schemas, logs, and
   named implementation surfaces.
3. Verify relevant primary sources for external APIs, framework rules,
   specifications, permissions, product limits, and data contracts.
4. Decide whether evidence proves that the plan is contradicted by reality,
   impossible as written, unsafe, stale, or already satisfied by existing code
   and tests.
5. Before editing the affected code, send a deviation notice with the exact plan
   item, checks performed, evidence labels and sources, impact, closest
   plan-preserving alternative, and user decision or proof needed.

If the evidence does not prove one of those conditions, follow the plan. If the
proof cannot be performed with available access, stop and make the missing proof
or planning decision explicit. Do not ask the user to approve an evidence-free
deviation.

A correction classified by the Plan Validity Gate as plan-preserving is not an
unapproved deviation merely because it changes a lower-level implementation
detail. A correction classified as plan-changing remains a deviation and needs
the owning requirements or plan contract to be revised and rebound before
implementation.

## Plan Validity Gate

Run this gate before or during implementation whenever the plan appears
self-contradictory, a planned implementation step would fail the plan's own
acceptance criteria, local code or tests disprove a planning assumption, a
review finding exposes a likely regression, or the user names a concrete failure
mode in follow-up.

Use this gate to avoid two opposite failures: do not rewrite plans based on
taste, but also do not ship known-bad behavior because it was written in the
plan. Complete these steps:

1. Re-read the affected goal, requirements, acceptance criteria, non-goals,
   constraints, test plan, risks, proceed condition, and implementation step.
2. Verify the issue with current `Local evidence` or a `Primary source` when the
   conflict depends on code, data contracts, permissions, external APIs, current
   diffs, or test behavior. Treat an unverified concern as `Unproven`, not as a
   reason to rewrite the plan.
3. Classify the fix:
   - **Plan-preserving correction**: changes the means while preserving the
     existing goal, requirements, acceptance criteria, non-goals, data handling,
     permissions, security posture, and UX behavior. This is not unapproved
     scope expansion; implement the correction after recording the evidence and
     the rejected known-bad planned step.
   - **Plan-changing correction**: changes product behavior, scope, data
     handling, permissions, security posture, UX, external contracts, release
     process, acceptance criteria, proof strategy, test strategy, or the
     implementation contract. Stop execution, name the owning requirements or
     plan artifact, and request or perform a separate revision phase before
     editing that behavior. A chat-only approval to "just patch it" is not a
     replacement for rebinding the changed contract.
4. If neither proof nor a plan-preserving correction is available, stop at the
   blocker. Do not complete the known-defective planned implementation and do
   not defend it as "required by the plan".

When the user challenges an in-progress or completed slice with a concrete
failure mode, run the same gate before arguing from plan text. If the challenge
is verified and the correction stays within the existing contract, repair it as
part of the current slice; if it changes the contract, stop for the smallest
decision needed.

## Startup Consent Preflight

After binding the plan and before editing, staging, committing, delegating
implementation, running destructive operations, triggering external side
effects, or starting a slice whose later separation depends on a consented
operation, scan the bound plan and current user instruction for consent-bound
items.

Consent-bound items include:

- Repository history operations outside the bound plan's scoped local checkpoint
  policy: unplanned staging or committing, amending, stashing, resetting,
  release preparation, version bumps, squashes, push, or checkpoint scope
  changes.
- Destructive, irreversible, credential-exposing, paid, production, or external
  side-effecting operations.
- Host delegation or orchestration that shares work with other agents, runs
  implementation unattended, or crosses a consent boundary.
- Accepted-risk, plan-deviation, data-handling, permission, security, or UX
  decisions that the plan says require user approval before the current slice.

For each item, record the `Plan` source, the exact operation, when it would
occur, current authorization evidence, and the fallback if authorization is
denied or absent. Current authorization must name the operation or decision,
except that an eligible bound-plan `Commit checkpoints` section or "commit after
each slice" instruction names local checkpoint commits for the plan's verified
checkpoint scopes when the user asks to execute, implement, apply, or continue
that plan. A general request such as "execute this plan", "continue", or "go
ahead" does not authorize other consent-bound operations.

If any consent-bound item lacks exact authorization, pause before implementing
the affected slice and ask for the smallest exact decision. If the current user
instruction or project policy denies commits for a plan that contains commit
checkpoints, follow that decision: implement at most the current checkpoint,
report the verified uncommitted state and checkpoint message, and stop before
the next planned checkpoint unless the user explicitly chooses another
non-commit checkpoint strategy.

## Delegated Execution Support

When the host exposes a delegation or sub-agent capability — ad-hoc sub-agent
calls or one scripted orchestration run that executes several bounded units
under a single deterministic, independently recorded run — delegated units may
carry bounded sub-tasks of an authorized slice: re-verification reads, test or
check runs, evidence gathering, review-only post-implementation review under
the Post-Implementation Review Gate, or implementation of an already-locked
slice. Do not require a specific host orchestration tool.

When the host lets you choose a delegated model and the user has not explicitly
fixed one, choose a fit-for-purpose model per delegated unit. Use cheaper or
faster models only for bounded re-verification reads, mechanical checks, or
simple review, and use higher-capability or larger-context models for
implementation, plan-contract judgment, cross-file synthesis, adversarial
review, high-risk sections, or deviation/consent-adjacent analysis. Do not
inherit the top model for every small unit, and do not downshift solely to save
tokens when the slice needs stronger reasoning. Record any explicit user model
override or the capability/context reason for a non-default model in the
delegation or review gate record when the host exposes that metadata.

Delegation never weakens the plan contract:

- Every delegated unit receives the bound plan contract for its task: slice
  scope, acceptance criteria, constraints, non-goals, and the relevant
  high-risk sections. A unit that does not know the contract cannot protect it.
  Record that handoff per delegated unit before treating delegated work as
  contract-bound.
- Delegated units cannot prompt the user. Any step that can hit a stop
  condition, a Plan Deviation Gate decision, or a consent boundary must either
  stay with the coordinator or make the delegated unit stop and report instead
  of deciding.
- Plan binding, deviation decisions, checkpoint commit authorization, history
  operations, progress-ledger updates, and final verification against the plan's
  acceptance criteria stay with the coordinator.
- A request to let delegated units or a scripted run commit automatically when
  checks pass does not move history operations into that delegated run. Treat it
  at most as authorization for coordinator-managed commits after the coordinator
  verifies the completed checkpoint as `Local evidence`, runs the
  Post-Implementation Review Gate, and confirms the scoped file set.
- Run delegated implementation of different slices concurrently only when the
  bound plan defines those slices as independent and the host isolates their
  working state from each other; otherwise execute serially.
  A coordinator-inferred shared interface, provisional result shape, polling
  loop, or pre-launch contract note does not make plan-ordered slices
  independent when the plan says a later slice starts only after an earlier
  slice is implemented or verified.
- Treat delegated results as `Unproven` until the coordinator verifies them as
  `Local evidence` with the plan's checks.
