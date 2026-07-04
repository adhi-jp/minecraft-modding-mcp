# Execution Workflow and Quality Reference

Read this reference before executing a bound plan slice, launching post-implementation review, updating the implementation-progress ledger, communicating completion or blockers, or applying the final quality checklist.

## Post-Implementation Review Gate

This gate reviews the implemented slice's diff against the bound plan's
acceptance criteria and non-goals. It runs after each slice or planned
checkpoint is implemented and the plan's verification checks have been run,
before the execution summary, before the next planned checkpoint starts, and
before any authorized commit. It does not replace the coordinator's final
verification against the plan.

Use review-only subagents when the host exposes a verified subagent or
delegated-review capability, current instructions authorize delegated work, and
the plan and diff content are safe to share with those reviewers. Capability
wording must stay host-neutral: do not require a specific tool name, model ID,
provider, plugin, server, marketplace, or network path. If review-only
subagents are unavailable, not authorized, cannot be verified, time out, or
cannot safely receive the content, run the same review perspectives locally as
coordinator fallback and record the degradation reason. Never claim a delegated
review ran when it did not.

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
  current-slice boundaries, approved deviations, high-risk sections,
  durable-artifact language hygiene for touched durable text, and
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

The `plan-contract compliance` handoff always includes a fixed durable-artifact
language hygiene item when the diff creates or edits comments, docstrings, test
names, commit messages, README/changelog entries, or similar durable text. This
item is required even when the bound plan did not name it. Reviewers must flag
bare plan-only identifiers that do not stand alone for a future reader, such as
slice, acceptance-criteria, requirement, question, hypothesis, step, checkpoint,
or phase labels. They must preserve useful resolvable anchors when those anchors
explain behavior or trace to a durable source, including paths, commands, API
names, product or domain terms, public issue IDs, stable error codes, function
names, field names, and code identifiers.

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
   - Extract `Implementation progress` when present. Reconcile the ledger with
     the implementation steps and commit checkpoints, identify the first
     `Not started`, `In progress`, or `Blocked` item that the current request
     authorizes, and verify any existing `Completed` claim before relying on it.
     If the section is absent from a writable multi-item or checkpointed plan,
     derive a minimal ledger from the bound implementation steps and checkpoint
     scopes without changing the plan contract.
   - Quote or paraphrase the plan's `Proceed condition` when it has one. For
     artifact-backed planning outputs, read the `Proceed condition` before other
     sections.
   - Extract consent-bound plan items, including history operations outside
     scoped planned checkpoint commits and other steps that require exact user
     authorization before implementation, delegation, external side effects, or
     repository history mutation.
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
   - If the missing consent affects delegated execution, external side effects,
     destructive operations, data handling, permissions, security, UX, release
     work, or history mutation outside scoped planned checkpoint commits, stop
     until the user decides or choose the plan-preserving fallback stated in the
     preflight.
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
   - When the Plan Validity Gate classifies a plan-changing correction, stop
     execution and return to the requirements or planning artifact that owns the
     changed contract. Do not continue by patching code against stale acceptance
     criteria, tests, or risk assumptions.
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
   - For writable artifact-backed plans, update the `Implementation progress`
     section for the locked item to `In progress` before meaningful edits when
     that update itself is safe and does not overwrite unrelated plan changes.
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
   - If the diff creates or edits durable text, inspect durable-artifact
     language hygiene and record the result before the execution summary or any
     authorized commit; classify any material wording finding with the other
     review findings.
   - Review the final diff against the plan's acceptance criteria and non-goals.
   - Report any skipped check with the reason and residual risk.
   - Update `Implementation progress` after the item is verified and reviewed:
     record `Completed` only with evidence-backed verification and review
     disposition, or record `Blocked` / `Skipped with approved deviation` with
     the evidence, residual risk, and next required action. If the local plan
     artifact is unavailable or unwritable, put the same progress row in the
     execution summary and say the artifact was not updated.
8. **Review and commit verified planned checkpoints**
   - Treat eligible commit checkpoints in a bound plan as scoped authorization
     for local coordinator-managed commits when the current user request asks to
     execute, implement, apply, or continue that plan and no current user or
     project instruction denies commits.
   - Do not pause only to ask for another "commit" instruction before a planned
     verified checkpoint. Commit each completed checkpoint after verification,
     the Post-Implementation Review Gate, material finding disposition, and
     staged/file-set confirmation, before starting the next planned checkpoint.
   - Planned checkpoint authorization covers only the checkpoint's scoped local
     commit. It does not authorize push, release preparation, version bumps,
     amend, reset, stash, squash, destructive operations, external side effects,
     work-in-progress commits, failing or skipped verification commits, or
     scope-changing commits.
   - When the current user instruction or project policy denies commits for a
     checkpointed plan, follow that decision; do not run through later
     checkpoints by default. Stop at the first verified uncommitted checkpoint
     unless the user explicitly chooses another non-commit checkpoint strategy.
   - When the bound plan has no planned commit or history operation and
     implementation is authorized, missing commit authorization does not block
     the ready slice. Implement and verify it, then report the verified
     uncommitted state and any proposed checkpoint message before staging,
     committing, or other history mutation.
   - Keep each commit logically scoped to the verified checkpoint change.
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
   - After each authorized checkpoint commit, update the plan artifact's
     `Implementation progress` row with the commit action and next item before
     starting the next planned checkpoint. If commits are denied or no commit is
     planned, record the verified uncommitted status instead of leaving the row
     ambiguous.

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
- A verified plan-changing correction has not been reflected in a revised
  requirements spec, implementation plan, or replacement plan contract that can
  be rebound before execution resumes.
- The requested edit requires changing scope, architecture, data model,
  permissions, billing, security posture, UX behavior, or release process beyond
  the plan.
- A consent-bound plan item lacks exact authorization and affects delegated
  execution, external side effects, destructive operations, data handling,
  permissions, security, UX, release work, or history mutation outside eligible
  bound-plan local checkpoint commits.
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
implementation-ready slice when the bound plan has no planned history operation,
or when the bound plan has eligible local commit checkpoints and the user asks
to execute, implement, apply, or continue that plan without denying commits.
Stop only when the needed history operation falls outside that scoped checkpoint
authorization, the current user instruction or project policy denies commits, or
the checkpoint cannot be verified, reviewed, or scoped safely.

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
- When startup consent is missing for operations outside scoped planned
  checkpoint commits, ask for exact operation-specific decisions before the
  affected slice and explain the data, permission, delegation, external side
  effect, release, or history risk that makes the decision current rather than
  optional cleanup.
- Include the plan's `Proceed condition` in the initial binding note or the
  first blocker notice, even when later local evidence overrides it.
  If the final response is the first durable handoff, or if the run included
  authorized commits, repeat the plan source and `Proceed condition` status
  there too; do not rely on a transient progress note to carry that evidence.
- When a plan artifact contains an `Implementation progress` ledger, include the
  current item status in blocker notices and final summaries. Name whether the
  ledger was updated in the plan artifact; if not, include the evidence-backed
  progress row in the summary so a later session can resume without inferring
  status from chat-only prose.
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
- When a plan-changing defect stops execution, name the revision target
  explicitly, such as the current requirements spec path, implementation plan
  path, or missing replacement-plan artifact. State that implementation resumes
  only after that artifact or contract is updated and rebound.
- Keep execution summaries durable. Replace prompt-local or harness-local
  phrases such as `this eval`, `as requested`, `above`, `current prompt`, or
  `current conversation`, `current instruction`, and `this eval workspace` with
  the concrete plan title, file path, provided fixture workspace, workspace
  access state, or explicit user instruction they refer to.
- In the final response, include the bound plan source, implemented slice,
  verification performed, Post-Implementation Review Gate execution mode and
  material finding dispositions, the durable-artifact language hygiene result
  when applicable, progress-ledger update status, plan deviations or blockers,
  and any remaining planned steps. For committed checkpoints, show the
  verification that cleared each checkpoint before the commit.

## Quality Checklist

Before finalizing:

- The implementation plan was explicitly identified.
- Any referenced local plan file was read before using a summary.
- The plan's `Proceed condition`, when present, was quoted or paraphrased before
  editing or in the first blocker notice.
- The plan's `Implementation progress` ledger, when present, was read before
  choosing the current item, reconciled with implementation steps and commit
  checkpoints, and treated as stale until current evidence confirmed any
  completion claim. If the ledger was absent from a writable multi-item or
  checkpointed plan, a minimal ledger was initialized from the already-bound
  steps or checkpoint scopes without changing the plan contract.
- The current slice stayed inside the plan or the user approved an
  evidence-backed deviation after the Plan Deviation Gate was satisfied.
- No planned step was skipped, reordered, narrowed, or replaced for perceived
  redundancy without passing the Plan Deviation Gate first.
- Any internally inconsistent or known-defective plan step passed the Plan
  Validity Gate before implementation continued; plan-preserving corrections
  were evidenced and plan-changing corrections stopped for artifact revision
  before implementation resumed.
- Plan-changing defects returned to the owning requirements or planning
  artifact before affected code changed; execution did not proceed through
  one-off patches against stale plan text.
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
- When the diff created or edited durable text, the review handoff included the
  durable-artifact language hygiene item, the coordinator recorded its result,
  and any material wording finding was classified before the execution summary or
  any authorized commit.
- The final diff was reviewed against plan scope and non-goals.
- `Skill usage plan` rows, when present, were bound and route availability was
  re-checked before use.
- Consent-bound plan items were extracted during plan binding, and unresolved
  exact authorization for operations outside scoped planned checkpoint commits
  was handled by Startup Consent Preflight before the affected slice.
- Eligible planned commit checkpoints were treated as scoped local commit
  authorization for the checkpointed plan only when the user asked to execute,
  implement, apply, or continue that bound plan and no current user or project
  instruction denied commits.
- Missing commit authorization did not block an otherwise ready slice when the
  bound plan had no planned history operation, or when the bound plan contained
  eligible commit checkpoints covered by the scoped checkpoint rule. Denied,
  unsafe, unverified, failing, unscopable, or out-of-scope history operations
  stopped before the next checkpoint or affected operation.
- Checkpoint commits, if any, were made only after verification,
  Post-Implementation Review Gate completion, material finding disposition, and
  staged/file-set confirmation, and used standalone Conventional Commit messages
  without prompt or plan-label leaks.
- Proposed commit messages were not wrapped in Markdown fences, and execution
  summaries did not rely on prompt-local or harness-local references.
- Final checkpoint summaries preserved the bound plan source, `Proceed
  condition` status, per-checkpoint verification result, commit action, and any
  skipped or failing verification status.
- The writable plan artifact's `Implementation progress` row was updated after
  each completed, blocked, skipped, or committed item without changing scope,
  requirements, acceptance criteria, tests, risks, or implementation steps. When
  the artifact could not be updated, the final summary included the same
  evidence-backed row and the reason the durable ledger was not changed.
