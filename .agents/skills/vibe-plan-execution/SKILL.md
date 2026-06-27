---
version: 3.0.1
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
- Missing commit authorization is not a generic implementation blocker for a
  plan that has no planned history operation. When the plan's proceed condition
  and the user's instruction to execute or implement the plan allow
  implementation but do not authorize commits, implement and verify the ready
  slice, then stop before staging, committing, or other history mutation.
- A plan-authored `Commit checkpoints` section, "commit after each slice"
  instruction, release step, destructive operation, external side effect,
  delegated execution request, or other user-consent boundary is different: it
  is a consent-bound plan item. If exact authorization is missing, run the
  Startup Consent Preflight before editing the affected slice. Do not implement
  through later slices hoping to reconstruct scoped commits or consent decisions
  from a larger mixed diff.
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
the usual user decision before implementation.

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
     process, or acceptance criteria. Stop and ask for a planning update or
     explicit decision before editing that behavior.
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

- Repository history operations: commit checkpoints, staging, committing,
  amending, stashing, resetting, release preparation, version bumps, squashes, or
  "commit after each slice" instructions.
- Destructive, irreversible, credential-exposing, paid, production, or external
  side-effecting operations.
- Host delegation or orchestration that shares work with other agents, runs
  implementation unattended, or crosses a consent boundary.
- Accepted-risk, plan-deviation, data-handling, permission, security, or UX
  decisions that the plan says require user approval before the current slice.

For each item, record the `Plan` source, the exact operation, when it would
occur, current authorization evidence, and the fallback if authorization is
denied or absent. Current authorization must name the operation or decision. A
general request such as "execute this plan", "continue", "go ahead", approval
of the plan's implementation scope, or acceptance of a checkpoint boundary is
not authorization for the consent-bound operation itself.

If any consent-bound item lacks exact authorization, pause before implementing
the affected slice and ask for the smallest exact decision. For planned commit
checkpoints, ask before editing the first checkpointed slice whether the user
authorizes coordinator-managed commits at the planned verified checkpoints or
wants a different checkpoint strategy. If the user declines commits or does not
decide, do not run through later planned slices by default; implement at most
the first verified checkpoint and stop before the next planned slice, unless the
user explicitly chooses another non-commit checkpoint strategy.

## Delegated Execution Support

When the host exposes a delegation or sub-agent capability — ad-hoc sub-agent
calls or one scripted orchestration run that executes several bounded units
under a single deterministic, independently recorded run — delegated units may
carry bounded sub-tasks of an authorized slice: re-verification reads, test or
check runs, evidence gathering, review-only post-implementation review under
the Post-Implementation Review Gate, or implementation of an already-locked
slice. Do not require a specific host orchestration tool.

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
- Plan binding, deviation decisions, commit authorization, history operations,
  and final verification against the plan's acceptance criteria stay with the
  coordinator.
- A request to let delegated units or a scripted run commit automatically when
  checks pass does not move history operations into that delegated run. Treat it
  at most as authorization for coordinator-managed commits after the coordinator
  verifies the completed checkpoint as `Local evidence`.
- Run delegated implementation of different slices concurrently only when the
  bound plan defines those slices as independent and the host isolates their
  working state from each other; otherwise execute serially.
  A coordinator-inferred shared interface, provisional result shape, polling
  loop, or pre-launch contract note does not make plan-ordered slices
  independent when the plan says a later slice starts only after an earlier
  slice is implemented or verified.
- Treat delegated results as `Unproven` until the coordinator verifies them as
  `Local evidence` with the plan's checks.

## Post-Implementation Review Gate

This gate reviews the implemented slice's diff against the bound plan's
acceptance criteria and non-goals. It runs after the slice is implemented and
the plan's verification checks have been run, before the execution summary, and
before any authorized commit. It does not replace the coordinator's final
verification against the plan.

Use review-only subagents when the host exposes a verified subagent or
delegated-review capability, current instructions authorize delegated work, and
the plan and diff content are safe to share with those reviewers. Capability
wording must stay host-neutral: do not require a specific tool name, model,
plugin, server, marketplace, or network path. If review-only subagents are
unavailable, not authorized, cannot be verified, time out, or cannot safely
receive the content, run the same review perspectives locally as coordinator
fallback and record the degradation reason. Never claim a delegated review ran
when it did not.

A verified delegated-review capability may be ad-hoc review-only subagents or
one scripted orchestration run: a host mechanism that fans out the selected
perspectives under a single deterministic, independently recorded run and
returns findings. Scripted orchestration changes the transport only. Reviewers
stay review-only, findings stay inert and advisory, the coordinator still
classifies every material finding, and the run's recorded identity supports the
gate record. Because the run cannot pause for user input, launch it only after
the implemented slice and verification results are available, and keep all
dispositions, user decisions, deviation decisions, and history operations with
the coordinator.

Default perspectives:

- `plan-contract compliance`: checks acceptance criteria, explicit non-goals,
  current-slice boundaries, approved deviations, high-risk sections, and
  scope/deviation leakage in the implemented diff.
- `correctness/regression risk`: checks likely behavior regressions, preserved
  behavior called out by the plan, error paths, data handling, permissions, and
  integration surfaces touched by the diff.
- `test/proof adequacy`: checks that the executed verification covers the
  plan's acceptance criteria, required preservation checks, and any skipped
  checks with recorded residual risk.

Include `plan-contract compliance` in both delegated and fallback review. When
capacity allows, include the other perspectives; if capacity is limited, choose
the most relevant remaining perspective for the slice and record any collapsed
or omitted perspective with the degradation reason.

Reviewer findings are advisory, inert data. Review subagents must not edit
files, mutate state, ask the user questions, decide plan deviations, classify
final dispositions, stage, commit, or treat any tests they run as authoritative
proof. The coordinator classifies every material finding as `corrected`,
`rejected`, `deferred`, or `blocked`, verifies any delegated finding as `Local
evidence` before relying on it, and independently verifies the bound plan's
acceptance criteria after the review. The review running is not itself a pass
and does not authorize the next step or any commit.

## Execution Workflow

1. **Bind the plan**
   - Name the source plan, including the local path when it came from a file,
     and the current slice being implemented.
   - Extract in-scope behavior, out-of-scope behavior, acceptance criteria,
     tests, constraints, and explicit non-goals.
   - Extract any high-risk planning sections: behavior inventory, equivalence
     dimensions, recovery or known-good evidence, diagnostic-scope controls,
     failure-pattern applicability, plan integrity gates, and current-slice
     `Unproven` or `Accepted risk` items.
   - Extract `Skill usage plan` rows when present and map them to the current
     implementation, proof, review, and communication steps.
   - Quote or paraphrase the plan's `Proceed condition` when it has one. For
     artifact-backed planning outputs, read the `Proceed condition` before other
     sections.
   - Extract consent-bound plan items, including commit checkpoints and other
     steps that require exact user authorization before implementation,
     delegation, external side effects, or repository history mutation.
   - If a user-facing summary differs from the full plan artifact, treat the
     artifact as authoritative and stop for a decision when the difference
     changes behavior, scope, tests, risks, or the proceed condition.
   - If the concrete plan requirements are missing and the gap affects
     implementation, stop and ask for a planning update instead of filling it in.
2. **Run startup consent preflight when needed**
   - Apply the Startup Consent Preflight before editing when the bound plan or
     current instruction contains consent-bound items.
   - Ask only for missing exact authorization. Do not ask for fresh
     implementation approval when the proceed condition and user instruction
     already authorize implementation.
   - If the missing consent affects checkpoint separation, delegated execution,
     external side effects, destructive operations, data handling, permissions,
     security, UX, release work, or history mutation, stop until the user decides
     or choose the plan-preserving fallback stated in the preflight.
3. **Verify before editing**
   - Inspect the relevant files, tests, configuration, schemas, and docs.
   - Re-check any plan-authored `Local investigation` that affects the current
     slice and record the current workspace result as `Local evidence` before
     using it.
   - Verify current availability for any `Skill usage plan` route before
     relying on that route; if unavailable, use the plan's fallback instead of
     inventing a companion workflow.
   - Use official docs or upstream source for external APIs, framework rules,
     product limits, permissions, data contracts, and unstable facts.
   - Compare the plan with local reality. Record conflicts before choosing an
     implementation path.
   - Run the Plan Validity Gate when a planned implementation step conflicts
     with the plan's higher-level behavior contract, local reality, current
     diff, review evidence, or a concrete user-reported failure mode.
   - If a planned inspection step is required before code or tests and the
     relevant files cannot be read, stop at the blocker and proof path. Do not
     draft implementation code, test templates, import paths, helper names, TTL
     values, schemas, or assertions for that slice until the inspection becomes
     current `Local evidence`.
   - Treat omitted or stale high-risk sections as plan problems when their
     preconditions still apply locally; do not silently replace them with a
     weaker proof path.
   - Run the Plan Deviation Gate before skipping, reordering, narrowing, or
     replacing any planned proof, API/specification check, test, or edit.
4. **Lock the current slice**
   - Implement only the smallest coherent unit from the plan that can be tested.
   - Keep future phases, nice-to-have improvements, and adjacent cleanup out of
     the edit unless the bound plan includes them.
   - If the user asks to add scope mid-implementation, classify it as a plan
     change and get explicit agreement before editing.
   - Treat omitting a planned step as a deviation when that step could affect
     correctness, contracts, tests, data handling, permissions, security, or UX.
5. **Prove behavior before or alongside code**
   - Follow the test or proof strategy in the plan.
   - For bug fixes, reproduce the failure or add a regression test when feasible.
   - For refactors, protect existing behavior with equivalence checks.
   - When the plan includes behavior inventory, equivalence, recovery, or
     selected failure-pattern checks, verify every current-slice contract those
     sections marked as `must preserve`, `Changed (in scope)`, or selected for
     high-risk proof.
   - For UI work, verify states and responsive behavior the plan calls out.
6. **Implement conservatively**
   - Reuse local helpers, conventions, naming, and architecture.
   - Keep changes close to the planned files and behavior surface.
   - Add comments only when they clarify non-obvious reasoning.
7. **Verify and review**
   - Run the plan's checks plus the repository's relevant lint, type, test, build,
     or manual smoke checks.
   - Run the Post-Implementation Review Gate on the implemented slice's diff
     after verification and before the execution summary or any authorized
     commit.
   - Classify material review findings as `corrected`, `rejected`, `deferred`,
     or `blocked`; verify delegated findings as `Local evidence` before relying
     on them, and do not treat the review itself as a pass.
   - Review the final diff against the plan's acceptance criteria and non-goals.
   - Report any skipped check with the reason and residual risk.
8. **Commit verified checkpoints when authorized**
   - Treat commit checkpoints in a bound plan as proposed commit boundaries, not
     commit authorization.
   - Commit only when the user explicitly authorizes the exact commit operation,
     or the bound plan approval text separately and explicitly authorizes commit
     execution for the requested work.
   - "Execute this plan", "implement the plan", or a `Commit checkpoints`
     section alone is not commit consent.
   - When the bound plan includes commit checkpoints, resolve missing commit
     authorization in the Startup Consent Preflight before editing the first
     checkpointed slice. If the user declines or does not decide, do not
     implement through later checkpoints by default; stop at the first verified
     uncommitted checkpoint, or follow the exact alternate checkpoint strategy
     the user chose.
   - When the bound plan has no planned commit or history operation and
     implementation is authorized, missing commit authorization does not block
     the ready slice. Implement and verify it, then report the verified
     uncommitted state and any proposed checkpoint message before staging,
     committing, or other history mutation.
   - Commit after each completed and verified phase, slice, or checkpoint. Keep
     each commit logically scoped to the verified change.
   - Do not commit discovery-only, unverified, failing, or work-in-progress states
     unless the user explicitly accepts that exact state.
   - Use Conventional Commits and the repository's commit rules.
   - Write commit messages as standalone, durable prose: describe the actual
     behavior or documentation change, not prompt context, conversation context,
     or plan labels. Avoid references like `per the plan`, `above`,
     `as requested`, `Phase 1`, `step 2`, or `implementation plan`; name the
     concrete change instead. Omit order-only phase, slice, checkpoint, or
     step labels unless they are part of the product or domain name.
   - Use an outcome-focused subject. Add a body only when it preserves durable
     context the diff cannot recover: the reason, user-visible contract,
     compatibility constraint, accepted risk, non-goal, or verification that
     changes review confidence. Keep durable references such as issue IDs,
     commands, committed paths, public APIs, and stable error codes; translate or
     omit local-only run labels, private tool-session records, ignored generated
     reports, and other proof a fresh-clone reader cannot resolve.
   - When reporting a proposed commit message, write the commit-message bytes as
     raw message lines or inline text. Do not wrap the message itself in
     Markdown fences, labels, or explanatory wrappers that could be copied into
     the commit.
     This controls only the commit-message sub-artifact. Unless the user's
     requested deliverable is only a commit message, do not replace the required
     execution summary with a bare commit message.
   - After each authorized checkpoint commit, keep the proof visible in the
     durable execution summary: the checkpoint, verification command or manual
     check, result, commit action, and standalone commit message. A test file
     name or committed diff is not evidence that the check passed. If
     verification was skipped, unavailable, or failing, report that status
     instead of claiming a completed checkpoint.

## Stop Conditions

Stop before implementation, or pause an in-progress implementation, when:

- No concrete implementation plan is available.
- The plan cannot be bound to the current workspace or branch.
- The bound plan's proceed condition, blocker, or risk section says
  implementation is blocked.
- The plan omits behavior, tests, data handling, permissions, or external
  contracts needed for the current slice.
- Local evidence or a primary source contradicts the plan.
- The plan is internally inconsistent, or a planned implementation step would
  produce a verified defect, fail acceptance criteria, violate non-goals, or
  contradict safety, data-handling, permission, security, UX, or external
  contract constraints, and no plan-preserving correction is available.
- The requested edit requires changing scope, architecture, data model,
  permissions, billing, security posture, UX behavior, or release process beyond
  the plan.
- A consent-bound plan item lacks exact authorization and affects checkpoint
  separation, delegated execution, external side effects, destructive
  operations, data handling, permissions, security, UX, release work, or history
  mutation.
- An external API, library, framework, or product limit is relevant but unverified.
- A proposed deviation has not passed the Plan Deviation Gate.
- The Post-Implementation Review Gate cannot run in delegated mode or
  coordinator fallback, or material review findings remain unclassified or
  blocked before the execution summary or any authorized commit.
- The only reason for deviating is perceived redundancy, minimalism, preference,
  speed, memory, or another unverified assumption.
- The only available path is destructive, irreversible, credential-exposing, or
  unsafe without additional proof or permission.

Missing commit authorization by itself is not a stop condition for an
implementation-ready slice only when the bound plan does not include planned
commit checkpoints or other history operations. When the plan does include
them, unresolved startup consent stops the affected slice before implementation,
or stops before the next planned slice if the consent gap is discovered after a
verified checkpoint.

When stopping, explain:

1. What part of the plan is blocked.
2. The evidence behind the blocker.
3. How that evidence affects the plan's `Proceed condition`, when one exists.
4. The closest viable path that preserves the user's intent.
5. The decision or proof needed to resume.

## User Communication

- Keep progress updates tied to the plan: "I am implementing step 2" or "This
  conflicts with acceptance criterion 3."
- When bound to a plan file, include the path in the initial binding note so the
  user can see which artifact controls the work.
- When bound to an inline plan, name the plan title or goal, such as `inline
  Payment Webhook Plan` or `inline password-reset regression plan`. Do not
  describe the source as the current conversation, current prompt, current
  instruction, or eval workspace in user-facing output.
- When startup consent is missing, ask for exact operation-specific decisions
  before the affected slice and explain the checkpoint, data, permission,
  delegation, external side effect, release, or history risk that makes the
  decision current rather than optional cleanup.
- Include the plan's `Proceed condition` in the initial binding note or the
  first blocker notice, even when later local evidence overrides it.
  If the final response is the first durable handoff, or if the run included
  authorized commits, repeat the plan source and `Proceed condition` status
  there too; do not rely on a transient progress note to carry that evidence.
- When no concrete plan exists, say implementation is blocked and planning is
  the next step. Refer to a specific planning workflow only when it is
  appropriate or already active in the context.
- For non-technical users, describe consequences in workflow terms before naming
  the implementation detail. Keep evidence labels explicit but light, such as
  "根拠: `Plan` ..." or "Evidence: `Plan` ...".
- Do not bury plan deviations in the final summary. Call them out before editing
  with the exact plan item, checks performed, evidence, impact, closest
  plan-preserving alternative, and decision needed.
- When rejecting or correcting a flawed plan step, avoid framing the user or
  local evidence as "violating the plan". Explain which higher-level plan
  contract or verified fact the step would break, whether the correction is
  plan-preserving or plan-changing, and what decision is needed if any.
- Keep execution summaries durable. Replace prompt-local or harness-local
  phrases such as `this eval`, `as requested`, `above`, `current prompt`, or
  `current conversation`, `current instruction`, and `this eval workspace` with
  the concrete plan title, file path, provided fixture workspace, workspace
  access state, or explicit user instruction they refer to.
- In the final response, include the bound plan source, implemented slice,
  verification performed, Post-Implementation Review Gate execution mode and
  material finding dispositions, plan deviations or blockers, and any remaining
  planned steps. For committed checkpoints, show the verification that cleared
  each checkpoint before the commit.

## Quality Checklist

Before finalizing:

- The implementation plan was explicitly identified.
- Any referenced local plan file was read before using a summary.
- The plan's `Proceed condition`, when present, was quoted or paraphrased before
  editing or in the first blocker notice.
- The current slice stayed inside the plan or the user approved an
  evidence-backed deviation after the Plan Deviation Gate was satisfied.
- No planned step was skipped, reordered, narrowed, or replaced for perceived
  redundancy without passing the Plan Deviation Gate first.
- Any internally inconsistent or known-defective plan step passed the Plan
  Validity Gate before implementation continued; plan-preserving corrections
  were evidenced and plan-changing corrections stopped for a decision.
- Every approved deviation identified the exact affected plan item, verification
  performed, evidence labels and sources, impact, closest plan-preserving
  alternative, and user decision.
- Every implementation-affecting or decision-affecting claim came from `Plan`,
  `Local evidence`, `Primary source`, or scoped `Accepted risk`, and user-facing
  decisions used those labels even when no code was edited.
- Planned inspection blockers stopped before code or test templates for the
  affected slice.
- False or infeasible plan items were challenged with evidence and alternatives.
- Tests or proof checks matched the plan's acceptance criteria.
- The Post-Implementation Review Gate ran after implementation and verification,
  before the execution summary or any authorized commit; the review mode,
  degradation reason when applicable, perspectives, material findings, and
  dispositions were recorded, and delegated output was treated as `Unproven`
  until coordinator-verified as `Local evidence`.
- The final diff was reviewed against plan scope and non-goals.
- `Skill usage plan` rows, when present, were bound and route availability was
  re-checked before use.
- Consent-bound plan items were extracted during plan binding, and unresolved
  exact authorization was handled by Startup Consent Preflight before the
  affected slice.
- Commit checkpoints were treated as proposals unless explicit user or
  plan-approval commit authorization named the operation.
- Missing commit authorization did not block an otherwise ready slice only when
  the bound plan had no planned commit checkpoints or history operations; when
  planned checkpoints were present, startup consent was resolved before editing
  or execution stopped at the first verified uncommitted checkpoint.
- Authorized commits, if any, were made only after verified checkpoints and used
  standalone Conventional Commit messages without prompt or plan-label leaks.
- Proposed commit messages were not wrapped in Markdown fences, and execution
  summaries did not rely on prompt-local or harness-local references.
- Final checkpoint summaries preserved the bound plan source, `Proceed
  condition` status, per-checkpoint verification result, commit action, and any
  skipped or failing verification status.
