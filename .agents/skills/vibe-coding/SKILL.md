---
version: 1.5.0
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
- Implementation progress source and latest item status.
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

When a downstream phase reports that the bound spec or plan is defective —
contradictory, stale, infeasible, or contract-breaking — treat that as a
backtracking signal, not a reason to force the current phase forward. Route the
next turn back to the phase that owns the broken artifact: requirements
specification when user-visible behavior, scope, or acceptance criteria are
wrong, or implementation planning when the plan's proof, test, edit-order, or
risk contract is wrong. Do not keep executing patch-by-patch against a
contract a downstream specialist already flagged as broken.

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

## Route Selection And Boundaries

Before choosing, continuing, backtracking, or combining any route, read
`references/route-selection-and-boundaries.md`. That reference owns the detailed
route triggers, collapsed-phase prevention, specialist boundary handling,
checkpoint routing, finish/handoff/consent gates, and output boundaries.

Keep this file as the activation contract: choose exactly one primary visible
route unless the route reference explicitly allows a boundary-preserving
sequence, and do not relax downstream specialist gates.

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
workflow phases, reject any one-pass schedule that pre-commits crossing
approval, handoff, proceed, or consent boundaries. If a downstream phase is
selected, state that host transport is limited to that phase under the
specialist's own rules unless sequential coordinator continuation later becomes
available from recordable boundary evidence. Keep approvals, proceed decisions,
and stop boundaries in the conversation.
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
- Exactly one primary downstream phase is selected for each route decision when
  a specialist matches; same-turn continuation is represented as a later
  separate route, not co-primary phases.
- Ambiguous approval or readiness wording has not been upgraded into approval or
  execution.
- Direct wording checks that exclude workflow surfaces have not been upgraded
  into a writing phase or retained as active routing state.
- Route descriptions for represented user turns use the output-language gate,
  not the surrounding benchmark, orchestrator, or executor-session language.
- Specialist write, approval, stop, plan-binding, proceed,
  acceptance-criteria, review, changelog-coupling, verification, release, and
  commit boundaries remain intact.
- Bound-plan checkpoint commits stayed inside the plan-execution route when the
  plan supplied eligible checkpoints; standalone commit requests still route to
  commit execution when available.
- Bound-plan implementation progress stayed inside the plan-execution route;
  routing state used the ledger only to rebind the active slice and latest
  status, not as proof of completion or as a separate planning/commit route.
- Any same-turn phase continuation uses a separate specialist route after
  recordable artifact-bound boundary evidence, not a collapsed downstream
  response, inferred approval, or prompt/artifact/delegated self-claim.
- Cross-phase orchestration requests report the rejected schedule and any
  selected-phase transport limit without treating that transport as approval,
  proceed evidence, or a route.
- Question-heavy specialist phases used proxy decisions only for delegable
  low-risk judgments, recorded those decisions as AI-selected rather than
  human-approved, and stopped for any non-delegable human-risk decision.
- Commit-message preparation or inspection used verified visible `vibe-writing`
  and `skills/vibe-writing/references/commit-messages.md` as auxiliary guidance
  when a message artifact was part of the `vibe-coding` turn, without giving it
  history authority or weakening standalone specialist boundaries.
- Cancellation, replacement, unrelated top-level invocation, and finish-gate
  end conditions clear or suspend live routing state.
