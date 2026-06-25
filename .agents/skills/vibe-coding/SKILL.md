---
version: 1.2.1
name: vibe-coding
description: >
  Use when the user explicitly invokes vibe-coding through a host-specific skill
  command, host-provided invocation signal, or direct instruction such as
  "use `vibe-coding`" for a coding workflow.
---

# Vibe Coding

## Overview

`vibe-coding` is the top-level orchestration entry point for multi-turn
vibe-coding workflows. It classifies the user's current instruction into one
workflow phase, then routes that phase to the visible specialist skill whose
metadata matches it, while preserving each specialist's own write boundary,
approval gate, stop condition, and verification rules.

This skill routes work; it does not replace specialist skills and does not
authorize host command plumbing, release preparation, commits, generated eval
workspaces, or implementation outside a selected downstream phase.

This skill does not hardcode a specialist roster. Routes are resolved at
routing time from the skill metadata visible in the current environment, so the
family can grow or shrink without changing this skill.

## Activation

Activate this skill only when the current turn has one of these signals:

- An explicit host-specific skill invocation for `vibe-coding`, such as Claude
  `/vibe-coding` or Codex `$vibe-coding`. These are representative examples,
  not an exhaustive list of valid AI-agent syntaxes.
- A host-provided invocation signal that says `vibe-coding` is active.
- An explicit instruction such as "use `vibe-coding`".

Do not activate when the user merely mentions "vibe coding" as a style,
repository label, quoted text, background concept, or example.

After `vibe-coding` is already active, later related turns may continue through
Routing State without a new activation signal. Do not treat that continuation as
a fresh activation.

If activation lacks a concrete coding instruction, ask for the instruction and
do not select a downstream phase yet. Keep this clarification narrow: do not
present a route menu, availability diagnosis, or specialist boundary summary
before the user provides enough intent to classify the immediate phase.

## Routing State

Use conversation state and existing artifact paths as the routing-state
mechanism for this implementation. Do not require a separate persisted ledger
file.

Track these fields when they are known:

- Current goal.
- Current phase.
- Next route.
- Active artifact paths.
- Approval evidence or handoff state.
- Implementation plan path.
- Active execution slice.
- Debug symptom.
- Review target.
- Investigation question.
- Writing artifact.
- Pending approvals.
- Known blockers.

For later related turns, classify the user request before routing:

- `continue current workflow`
- `revise current artifact`
- `replace workflow`
- `cancel workflow`
- `unrelated ordinary request`

If stale context would change behavior and the class is unclear, ask one
clarifying question before routing. If context was lost after compaction or a
long interruption, rebind from the latest known artifact path when possible; if
that is not possible, ask for the missing artifact or decision.

On cancellation or replacement, clear the active phase, next route, pending
approvals, active slice, and live artifact bindings. Preserve completed artifact
paths only as historical context.

End or suspend `vibe-coding` mode when the user explicitly cancels it,
explicitly replaces the workflow with a different goal, explicitly invokes
another top-level skill or mode for an unrelated task, or the selected
downstream skill reaches its finish gate and the user gives no further related
instruction.

## Workflow Phases

Classify the immediate instruction into exactly one of these phases. Each phase
is defined by the work it owns, not by a specialist's name:

- **Requirements specification**: turning a vague, rough, contradictory,
  creative, non-technical, or underspecified coding goal into a requirements
  spec artifact, or revising and approving one.
- **Creative direction exploration**: generating implementation ideas,
  alternatives, interaction concepts, or implicit expected-behavior and
  convention checks before scope hardens, without a saved-requirements ask.
- **Code investigation**: read-only research into existing code or behavior —
  how something works, where it lives, what depends on it, what a change would
  affect — with no reported defect and no edit request.
- **Implementation planning**: creating or revising an implementation-plan
  artifact from approval-evidenced or concrete inputs.
- **Plan execution**: implementing a concrete bound implementation plan whose
  proceed condition allows execution.
- **Debug and repair**: diagnosing and repairing existing behavior from bug
  reports, regressions, failed fixes, tool failures, or runtime artifact
  mismatches.
- **Review**: reviewing a git-backed target or running a review/fix loop with
  scope triage and gated fixes.
- **Commit execution**: staging, committing, splitting, amending, or repairing
  repository history for the current changes, including commit file-set and
  message-transport decisions.
- **Writing**: wording, message content, localization, or text-format
  deliverables. A direct lexical, grammar, or naming judgment about a short
  label or identifier is not the writing phase when the user asks for only an
  immediate answer and excludes editing, review, planning, debugging, and
  written deliverables.

## Availability Gate

Before naming a downstream route, verify that a specialist skill whose visible
description matches the selected phase exists in the current environment,
user-provided material, repository metadata, or project instructions. Match by
phase and described capability, not by a memorized name list or a name
pattern: the supported route set is whatever phase-matching specialists are
visible at routing time. When a route is named in user-facing output, use the
matched skill's name exactly as its visible metadata states it.

A visible skill is a primary-route candidate only when its description matches
the selected phase's workflow scope and boundary obligations — its own write,
approval, stop, consent, or verification rules for that phase. A skill whose
description offers only a tool, command, or domain capability without that
workflow contract is an auxiliary candidate, not a primary route.

Do not assume a specialist exists because a past environment had one, and do
not invent names. New specialists become routable as soon as their metadata is
visible; absent specialists are not routable even when this family usually
includes them.

If the immediate phase matches no visible specialist, report
`matched-but-unavailable`, name the unmatched phase, name the availability
source checked, and preserve the phase boundary. Do not silently emulate the
missing specialist. If the missing route affects risk, artifacts, downstream
boundaries, or user expectations, ask whether to proceed without that
specialist.

If no phase matches the immediate task, continue with ordinary behavior. State
that no matching optional specialist was verified when that affects user
expectations. Do not create or retain active routing state for an unrelated
ordinary request only because `vibe-coding` was invoked.

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
Stop in that turn and record that the next related user instruction routes to
the implementation-planning phase. That next route is orchestrator state owned
by `vibe-coding`; it does not require the requirements specialist to name a
downstream workflow or continue into planning in the same turn.

### Creative Direction Exploration

Route explicit brainstorming, idea-generation, alternative-direction, or
expected-behavior and convention-check requests to the creative-exploration
phase when the user has not asked for a saved requirements artifact.

A confirmed direction from this phase is input to later requirements or
planning work, not implementation scope. When the user asks to capture the
chosen direction durably, route the next related instruction to the
requirements-specification phase.

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

When a commit-execution turn needs message wording and a writing specialist is
verified visible, that specialist is auxiliary authority for the message
artifact only: subject wording, body value, verification wording, durable
references, trailers as content, and multi-line transport shape. History
authority stays with the commit-execution phase, project rules, and explicit
user consent.

When no commit-execution specialist is visible but a `vibe-coding` turn
prepares or inspects a commit message, use a verified visible writing
specialist as mandatory auxiliary guidance for the message artifact, and keep
history authority with the applicable commit workflow, project rules, and
explicit user consent. If neither specialist is visible, state the fallback
when that affects user expectations and use repository commit rules, recent
local history, and supplied checkpoint messages.

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
  direction; confirmation is not implementation authorization.
- The code-investigation phase is read-only: it produces evidence-backed
  findings and never edits files, fixes defects, or mutates state.
- The implementation-planning phase writes implementation-plan artifacts only
  and does not authorize same-turn implementation.
- The plan-execution phase requires a concrete bound plan and its proceed or
  accepted-risk condition before code execution, then preserves the bound
  plan's scope, acceptance criteria, required documentation or changelog
  coupling, release policy, and verification path.
- The debug-and-repair phase owns existing-feature diagnosis and repair proof;
  repair proof does not authorize history mutation.
- The review phase owns review target selection, delegated review coordination,
  scope triage, gated fixes, terminal audit, and history-operation consent.
- The commit-execution phase owns staging, commit safety, message transport,
  trailers, and history repair under operation-specific consent; it does not
  push or rewrite shared history without explicit consent.
- The writing phase owns wording and text-quality deliverables; it does not
  authorize release, commit, staging, or workflow shortcuts.

Do not skip phases in the same turn when the selected downstream skill requires
stopping after an artifact, summary, approval, or proceed-condition boundary.

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

## User-Facing Output

Before writing a route description, apply this language gate.

Choose the user-facing route-description or summary language in this order:

1. An explicit output-language instruction in the current prompt.
2. The clear dominant language of a represented current user turn, including
   quoted current-user instructions and labeled or enumerated represented-turn
   examples, when the task asks you to classify or describe route behavior for
   that represented turn. If all represented turns share one clear language, use
   it for the whole route response, including headings.
3. The active user's conversational language.

A represented turn that contains only a host invocation, path, command, enum,
identifier, code, or other technical token is language-neutral. It does not
override or block a clear natural-language represented turn from setting the
route-description language for that turn, or for the whole classification set
when no represented turns conflict.

Do not inherit the surrounding benchmark, orchestrator, or executor-session
language when it differs from a represented current user instruction whose
route behavior you are simulating. Apply the selected language to headings,
bullets, rationale, and summaries. Preserve skill names, file paths, commands,
enum values, field names, and technical identifiers verbatim.

Show concise routing rationale when the phase changes, the selected route is not
obvious, a specialist is unavailable, or no matching specialist was verified and
that affects user expectations. Avoid ceremony on ordinary same-phase turns.
When a user asks host delegation or scripted orchestration to span multiple
workflow phases, state the rejected cross-boundary schedule and, if a downstream
phase is selected, state that any host transport is limited to that selected
phase under the specialist's own rules. Keep approvals, proceed decisions, and
stop boundaries in the conversation.
When a route description is for a current-turn activation signal, name the
activation source briefly, such as explicit invocation, host-provided signal, or
direct instruction. For continuation turns with active routing state but no
current-turn activation signal, continue from that state without inventing a new
activation source.

Ask only for decisions that materially affect scope, behavior, data handling,
permissions, verification, accepted risk, or workflow safety and cannot be
determined from local evidence or the active artifact.

## Self-Check

Before acting under `vibe-coding`, confirm:

- The turn has explicit current activation, or it is a later related turn in an
  active workflow, or the next response asks for the missing instruction without
  routing.
- Current-turn activation route descriptions name the activation source, while
  active-state continuation turns do not invent one.
- The current turn is classified against the active routing state.
- Any named downstream route has visible metadata, and its name came from that
  metadata rather than a memorized roster.
- Exactly one primary downstream phase is selected when a specialist matches.
- Ambiguous approval or readiness wording has not been upgraded into approval or
  execution.
- Direct wording checks that exclude workflow surfaces have not been upgraded
  into a writing phase or retained as active routing state.
- Route descriptions for represented user turns use the output-language gate,
  not the surrounding benchmark, orchestrator, or executor-session language.
- Specialist write, approval, stop, plan-binding, proceed,
  acceptance-criteria, review, changelog-coupling, verification, release, and
  commit boundaries remain intact.
- Cross-phase orchestration requests report the rejected schedule and any
  selected-phase transport limit without treating that transport as approval,
  proceed evidence, or a route.
- Commit-message preparation or inspection used a verified visible writing
  specialist as auxiliary guidance when a message artifact was part of the
  `vibe-coding` turn, without giving it history authority.
- Cancellation, replacement, unrelated top-level invocation, and finish-gate
  end conditions clear or suspend live routing state.
