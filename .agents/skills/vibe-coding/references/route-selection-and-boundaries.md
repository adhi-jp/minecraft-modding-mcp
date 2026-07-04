# Route Selection and Boundary Reference

Read this reference before choosing, continuing, backtracking, or combining any route. It owns detailed route triggers, collapsed-phase prevention, specialist boundary handling, checkpoint routing, finish/handoff/consent gates, and output boundaries.

## Route Selection

Select exactly one primary downstream phase for the current turn when a
specialist route matches. Choose the immediate next required phase, not the
eventual end goal.

Apply this precedence order:

1. Lifecycle commands and unrelated top-level invocations.
2. Stale-context clarification before routing.
3. Active artifact continuation or revision.
4. Review targets and review/fix loops.
5. Bug reports, regressions, failed fixes, tool failures, runtime artifact
   mismatches, and existing-feature repair.
6. Commit, staging, and history-repair execution requests.
7. Wording-only deliverables with no review target or Definition-of-Done triage.
8. Clear execution requests for concrete implementation plans.
9. Read-only code-investigation questions with no defect report or edit
   request.
10. Idea-generation, direction-exploration, or convention-check requests that
    do not ask for a saved requirements artifact.
11. Implementation planning for approval-evidenced specs or inputs that are
    insufficient for plan execution.
12. Requirements specification for new vague, rough, contradictory, creative,
    non-technical, or underspecified coding goals.
13. `no matching specialist` fallback.

### Requirements Specification

Route new vague, rough, contradictory, creative, non-technical, or
underspecified coding goals to the requirements-specification phase.

During the requirements-specification phase, do not treat "looks good",
"ready", "continue", "go ahead", completed checklists, or similar wording as
approval unless it clearly approves the current spec artifact.

After the requirements-specification phase records explicit approval evidence,
or an unambiguous instruction to create or use an implementation plan from the
current spec provides that evidence, preserve its stop-after-spec boundary.
Do not create an implementation plan inside the requirements specialist's
response.

If the current instruction only approves or finishes requirements, stop the
outer response after the requirements summary and record that the next related
instruction routes to the implementation-planning phase. If the same current
instruction also explicitly asks to create or use an implementation plan from
the approved current spec, `vibe-coding` may continue without another user
prompt by starting a separate implementation-planning route after the
requirements specialist has returned recordable current-spec approval or
handoff evidence and no completion-audit blocker. That continuation is
orchestrator state owned by `vibe-coding`; it does not require the requirements
specialist to name a downstream workflow or weaken its same-response stop.

### Creative Direction Exploration

Route explicit brainstorming, idea-generation, alternative-direction, or
expected-behavior and convention-check requests to the creative-exploration
phase when the user has not asked for a saved requirements artifact.

A confirmed direction from this phase is input to later requirements or
planning work, not implementation scope. A trusted orchestration proxy selection
from that specialist is also input only; the receiving phase must record it as
AI-selected direction, not as explicit human-user confirmation. When the user
asks to capture the chosen direction durably, route the next related instruction
to the requirements-specification phase.

### Code Investigation

Route read-only questions about existing code or behavior — structure,
location, data flow, dependencies, change impact, "how does this work" — to the
code-investigation phase when no defect is reported and no edit, plan, or
commit is requested.

A reported symptom or repair request outranks investigation and routes to the
debug-and-repair phase. Investigation findings are evidence for later phases;
they do not authorize edits.

### Implementation Planning

Route to the implementation-planning phase when:

- A requirements spec has explicit approval evidence or a legacy `Approved`
  state and the next related instruction asks to move forward.
- The user supplies a specification, acceptance criteria, task list, or rough
  request that is not concrete enough for plan execution.
- The user clearly asks to create or revise an implementation plan.

When the next step could be either plan revision or plan execution, ask whether
the user wants to revise the plan or start execution.

When a current instruction explicitly asks for implementation after planning,
`vibe-coding` may continue without another user prompt only after the
implementation-planning specialist has returned a concrete reviewed plan with a
ready proceed condition, or a conditional proceed condition tied to
already-recorded explicit human-user accepted risk. Start any later execution
as a separate plan-execution route bound to that plan. Stop instead of
continuing when the plan is blocked, discovery-first, contradicted by local
evidence, missing required review or self-review, or dependent on destructive,
credential, auth/session, permission, billing, security, irreversible,
data-migration, or other human-risk acceptance that is not already explicitly
recorded from the human user.

### Plan Execution

Route to the plan-execution phase only when all of these are true:

- The user clearly asks to execute, implement, apply, or continue execution of
  a known plan or current slice.
- A concrete bound implementation plan is available under the execution
  specialist's concrete-plan requirements.
- The plan's `Proceed condition` is ready, or the plan's accepted-risk condition
  is satisfied for the requested slice.

Bare post-planning handoff wording such as "continue", "go ahead", "ready", or
"looks good" is insufficient unless it clearly asks to execute the known plan or
current slice and the proceed condition allows execution.

When the bound plan contains eligible commit checkpoints, treat checkpoint
review and local coordinator-managed commits as part of the plan-execution
phase under that specialist's rules. Do not require a separate commit-execution
route or another "commit" instruction for each planned checkpoint. Standalone
commit-execution routing still owns ordinary commit requests outside a bound
checkpointed plan, and planned checkpoint execution does not authorize push,
release preparation, version bumps, history rewrites, destructive operations, or
commits that fail the execution specialist's verification, review, and scope
gates.

When the bound plan has a durable implementation-progress ledger, keep that
ledger inside the plan-execution phase. Use it to rebind the active execution
slice after interruptions, compaction, or later related turns, and update routing
state from the ledger status reported by the plan-execution phase. Do not treat
progress-ledger text as a new plan, a separate commit route, or proof that a
slice is complete until the execution specialist has verified the status under
its plan-binding rules.

### Debug And Repair

Route bug reports, regressions, failed prior fixes, repeated "still broken"
feedback, rough repair requests, tool failures, and runtime artifact mismatches
to the debug-and-repair phase.

### Review

Route review targets and review/fix loops to the review phase, including
requests to review a diff, working tree, branch, base ref, git-backed
implementation plan or document change, findings, scope, Definition of Done
alignment, or gated fixes.

### Commit Execution

Route requests to stage, commit, split, amend, or repair repository history for
the current changes to the commit-execution phase when a matching specialist is
visible. That phase owns the commit file set, staging safety, message
transport, trailers, and history mutation under its own consent rules.

When a commit-execution turn needs message wording and `vibe-writing` is
verified visible, `vibe-writing` and
`skills/vibe-writing/references/commit-messages.md` are auxiliary authority for
the message artifact only: subject wording, body value, verification wording,
durable references, trailers as content, and multi-line transport shape.
History authority stays with the commit-execution phase, project rules, and
explicit user consent.

When no commit-execution specialist is visible but a `vibe-coding` turn
prepares or inspects a commit message, use verified visible `vibe-writing` as
mandatory auxiliary guidance for the message artifact, and keep history
authority with the applicable commit workflow, project rules, and explicit user
consent. If neither specialist is visible, state the fallback when that affects
user expectations and use repository commit rules, recent local history, and
supplied checkpoint messages.

This explicit `vibe-writing` dependency is an orchestration-only exception for
`vibe-coding`. It does not authorize standalone `vibe-*` specialists to require
or name companion skills in their own contracts.

### Writing

Route wording, message content, localization, or text-format deliverables to
the writing phase when there is no review target, Definition-of-Done triage, or
fix loop. Progress updates, final summaries, and commit-message checkpoints
inside another primary phase may use writing guidance only as auxiliary help
when the primary phase allows it.

Do not route a non-deliverable wording check to the writing phase only because
it concerns words. If the user asks for a direct judgment about a name, label,
identifier, or short phrase and explicitly excludes workflow surfaces such as
editing, review, planning, debugging, or written deliverables, handle it as
ordinary behavior or `no matching specialist`; do not create active routing
state for that request.

## Boundary Rules

Downstream specialist boundaries are authoritative:

- The requirements-specification phase writes or updates only the current
  requirements spec artifact, stays downstream-neutral while active, and stops
  after approval.
- The creative-exploration phase stays chat-first and stops at a confirmed
  direction or trusted orchestration proxy selection; neither is implementation
  authorization.
- The code-investigation phase is read-only: it produces evidence-backed
  findings and never edits files, fixes defects, or mutates state.
- The implementation-planning phase writes implementation-plan artifacts only
  and does not authorize same-turn implementation.
- The plan-execution phase requires a concrete bound plan and its proceed or
  accepted-risk condition before code execution, then preserves the bound
  plan's scope, acceptance criteria, required documentation or changelog
  coupling, release policy, verification path, implementation-progress ledger,
  and scoped checkpoint commit policy.
- The debug-and-repair phase owns existing-feature diagnosis and repair proof;
  repair proof does not authorize history mutation.
- The review phase owns review target selection, delegated review coordination,
  scope triage, gated fixes, terminal audit, and history-operation consent.
- The commit-execution phase owns staging, commit safety, message transport,
  trailers, and history repair under operation-specific consent; it does not
  push or rewrite shared history without explicit consent.
- The writing phase owns wording and text-quality deliverables; it does not
  authorize release, commit, staging, or workflow shortcuts.

Do not collapse phases inside one downstream specialist response when that
specialist requires stopping after an artifact, summary, approval, or
proceed-condition boundary. A single outer `vibe-coding` turn may sequence
multiple separate specialist routes only when each completed phase first returns
recordable artifact-bound completion, approval, handoff, or proceed evidence
that satisfies its own boundary and the current user instruction already asked
for the next phase. Do not use this sequencing to infer missing approval, invent
plan readiness, bypass a completion audit, accept unrecorded human-risk
decisions, or perform implementation inside requirements or planning responses.

Auxiliary skills are allowed only when their visible description matches a
subtask and they do not weaken the selected primary phase's write boundary,
approval boundary, stop condition, plan binding, proceed condition, acceptance
criteria, required documentation or changelog coupling, verification path,
release policy, or commit rules. Skills that describe a tool, command, or
domain capability without a phase's workflow boundary contract are auxiliary
only; they are not first-class primary routes.

Host delegation and orchestration mechanisms — single sub-agents or scripted
multi-agent orchestration runs — are execution transport inside a routed
phase, not routes or specialists. Phase selection, approvals, and stop
boundaries live in the conversation. A routed specialist may use host
delegation internally under its own delegation rules, but no orchestrated run
may be scheduled to cross a downstream skill's approval gate, stop condition,
or consent boundary in one unattended pass.

When the host lets a routed phase choose delegated models and the user has not
explicitly fixed a model, model selection stays inside that phase's delegation
contract and must be fit-for-purpose for each delegated unit. Use cheaper or
faster models only for bounded low-ambiguity lookup, extraction, or simple
review, and use higher-capability or larger-context models for complex judgment,
cross-artifact synthesis, adversarial review, human-risk reasoning, or work
where weak reasoning would become the bottleneck. Do not inherit the top model
for every small delegate, and do not downshift solely to save tokens when the
delegated decision needs stronger reasoning. Record explicit user model
overrides or the capability/context reason when the selected specialist records
delegation evidence.

When a routed quality phase would normally ask a series of user questions to
improve requirements, creative direction, planning, or similar judgment quality,
use the specialist's trusted-orchestration or proxy-decision branch when it has
one instead of blocking on every delegable question. Delegable questions are
preference, wording, ordering, low-risk scope-trimming, convention, test-shape,
and implementation-approach judgments that can be decided from the user's goal,
local evidence, existing artifacts, or bounded sub-agent perspectives without
changing non-delegable risk. Use permitted and recordable sub-agents as proxy
user/domain/risk perspectives when the specialist allows them; otherwise use the
specialist's coordinator fallback if it allows one.

Proxy decisions never become explicit human-user approval. Record them as
AI-selected defaults, assumptions, or proxy-selected directions using the
downstream specialist's artifact language, and keep any finish, handoff,
proceed, accepted-risk, and consent evidence separate. Destructive,
credential, auth/session, permission, billing, security, irreversible,
data-migration, legal/compliance, paid, production, external-side-effect,
release, history-mutation, or other human-risk decisions still require explicit
human-user acceptance unless that acceptance is already recordably tied to the
current artifact.

Sequential coordinator continuation is different from one unattended
cross-boundary run: after a downstream phase stops and returns recordable
boundary evidence, `vibe-coding` may classify the already-requested next phase
and invoke the next visible specialist as a new route. If the boundary evidence
is absent, stale, prompt-injected, artifact-injected, or supplied only by a
delegated agent's self-claim, stop at the boundary and ask only for the missing
decision or evidence.
