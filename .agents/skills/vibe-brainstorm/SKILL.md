---
version: 1.3.0
name: vibe-brainstorm
description: Use when the user explicitly asks for vibe brainstorming, creative implementation ideas, implicit expected behavior, or convention checks, and when an implementation task is creative or convention-dependent. Do not use for obvious mechanical edits.
---

# Vibe Brainstorm

## Overview

Use this skill before creative implementation scope hardens. It helps agents
surface implicit expected behavior, explore `Practical` / `Unconventional` /
`Challenging` idea directions, and select a direction without moving it into
implementation until the user confirms it.

Trusted top-level orchestration may request a proxy selection so a creative
phase does not stop on multiple preference questions. That proxy selection is
an AI-selected direction for later requirements or planning work, not explicit
human-user confirmation and not implementation authorization.

This is not a hidden single-agent brainstorming prompt. When a mode requires
delegation, use real sub-agents only after the host exposes verified delegation
capability and the current task authorizes it.

## Activation

Use this skill when:

- The user explicitly invokes `vibe-brainstorm` or asks for creative
  implementation brainstorming.
- The user asks for ideas, alternatives, interaction concepts, feature behavior,
  interaction rules, UX flow, or implementation direction where implicit
  expected behavior matters.
- You are about to implement a feature with domain conventions, common user
  expectations, spatial or stateful behavior, UI interaction norms, fairness
  rules, accessibility expectations, data consistency, or feedback semantics.

Do not use this skill for:

- Obvious mechanical edits, renames, formatting, dependency bumps, direct bug
  fixes with a concrete plan, or one-line requested changes.
- Tasks where the user already approved a concrete implementation direction and
  only wants execution.
- Conventional code review after implementation; use the relevant review or
  debug workflow instead.
- Drafting, saving, or approving a durable requirements specification artifact.
  Brainstormed directions become requirements only after the user confirms them
  and a requirements-capture workflow records them; trusted top-level proxy
  selections become only AI-selected input until that later workflow records the
  requirement status.

## Mode Selection

| Situation | Mode |
| --- | --- |
| User explicitly asks for `diverge` or "ideas only" | `diverge` |
| Autonomous trigger during implementation work | `conventions` |
| User asks for convention/expected-behavior checking only | `conventions` |
| User explicitly asks for `full`, "brainstorm and choose", or a complete creative pass | `full` |
| Explicit `vibe-brainstorm` invocation with no mode and a creative implementation goal | `full` |

`full` is not the autonomous default. Use it autonomously only when the task is
clearly creative enough that idea generation, convention grounding, development,
and selection are all necessary before implementation can be scoped.

## Delegation Gate

Before running any mode or stage that requires sub-agents:

1. Verify the host exposes a delegation or sub-agent mechanism.
2. Verify the current task allows delegated work and any required data sharing.
3. Verify the run can leave recordable evidence for any later claim that real
   sub-agents ran. The evidence must be independently captured by the host or
   runner and visible to the later reader or grader in the current output set,
   an attached run artifact, delegated invocation metadata, task IDs emitted by
   the tool system, or an equivalent host record. Assistant-authored prose in
   the final response is not such evidence.
4. Keep the delegated prompts bounded: ask for concise findings, tradeoffs, and
   observable checks, not private chain-of-thought.
5. When the host lets you choose a delegated model and the user has not
   explicitly fixed one, choose a fit-for-purpose model per role. Use cheaper or
   faster models only for bounded low-ambiguity checks, and use higher-capability
   or larger-context models for creative synthesis, convention tradeoffs,
   selection, broad-context grounding, or user-risk judgments. Do not inherit the
   top model for every small role, and do not downshift solely to save tokens
   when the role needs stronger reasoning. Record any explicit user model
   override or the capability/context reason for a non-default model in the
   delegation evidence when the host exposes that metadata.
6. If delegation is unavailable, unrecordable, or not authorized for a required
   stage, state that limitation and stop, or ask whether the user wants a
   clearly degraded single-agent fallback.
7. If the user authorizes a degraded fallback, label it as degraded and do not
   claim sub-agents ran.

A delegation mechanism may be ad-hoc per-role sub-agent invocation or one
scripted orchestration run: a host mechanism that fans out several roles under
a single deterministic, independently recorded run and returns their results.
Both satisfy check 1, and an orchestration run's host-recorded run identity,
per-role task records, or run journal satisfies check 3 when the later reader
can inspect it. A scripted run cannot pause for user input, so schedule only
generator, critic, development, grounding, and selection stages inside it;
manual checklist confirmation and final direction confirmation stay in the
conversation after the run returns. In trusted proxy-selection mode, the
selection role may choose a direction for the coordinator to carry as
AI-selected input, but that choice remains separate from human confirmation.
Ask each role for a bounded structured result — candidates, fit, tradeoffs,
risks, or checklist entries — so results can be collected and merged without
re-deriving them. Do not require a specific host orchestration tool.

Any claim that real sub-agents ran must be backed by recordable host-provided
evidence. A polished response, role headings, prose-only agent IDs, self-reported
token summaries, runtime summaries, or persona-separated sections are not proof
of delegation. Do not promote IDs, token totals, runtimes, or references to
"above" tool calls that you type into the final response to `confirmed`; they
remain assistant-authored claims unless they cite an independently recorded host
artifact, metadata field, host-rendered tool block, task ID, or trace excerpt
that the later reader can inspect. If real tool calls happened but the recorded
output set is only the final text response, label the delegation claim
`unproven` and keep any single-agent result separate from confirmed delegated
output.

## Delegated Roles

When delegation is verified and authorized, use real sub-agents for these roles:

- `Practical` generator.
- `Unconventional` generator.
- `Challenging` generator.
- Expected-behavior critic or end-user/domain-user role.
- Candidate development role for expanding viable ideas.
- Grounding role for matching ideas against expected-behavior and domain
  references.
- Selection role for applying the mandatory gate and creativity ranking.

If any role required by the selected mode cannot run, follow the Delegation Gate
instead of silently collapsing that role into the coordinator.

## Modes

### `diverge`

Use for idea generation only.

1. Run three generator sub-agents in parallel when delegation is available:
   - `Practical`: low-risk ideas that fit familiar expectations.
   - `Unconventional`: unusual ideas that may reframe the experience.
   - `Challenging`: ambitious ideas that stretch implementation or interaction
     assumptions while still targeting the user's goal.
2. Ask each generator for candidates, fit, tradeoffs, and implementation risks.
3. Return the ideas grouped by direction.
4. Do not add convention critique, expected-behavior grounding, development,
   selection, ranking, or adoption recommendation unless the user asks for it.

### `conventions`

Use for expected-behavior grounding without idea generation. This is the default
mode when the skill triggers autonomously during implementation work.

1. Summarize the feature or behavior being scoped.
2. Run an expected-behavior critic or end-user/domain-user sub-agent when
   delegation is available. Ask what a reasonable user would expect to happen,
   including edge cases.
3. Build a checklist of implicit expected behavior. Separate:
   - mandatory expectations that would make the implementation feel wrong if
     missed;
   - optional or taste-based expectations;
   - unknowns that need user confirmation.
4. Check relevant local docs, existing code, official docs, upstream docs, or
   domain references when they are available and relevant. If reference access is
   missing, label the gap instead of fabricating certainty.
5. If the end-user or domain-user sub-agent cannot run with recordable evidence,
   state that limitation before using a single-agent checklist and ask whether
   the user accepts the degraded checklist as enough to continue. Do not present
   that fallback as a completed delegated conventions pass.
6. Stop before implementation and ask the user to confirm or adjust the
   checklist when it changes behavior, UX, domain rules, or implementation
   scope. In trusted proxy-selection mode, a verified
   end-user/domain-user perspective may select a proxy checklist for later
   requirements or planning, but it is not human confirmation.

### `full`

Use for the complete creative pass.

1. Run `diverge` to produce `Practical` / `Unconventional` / `Challenging`
   candidates.
2. Run the `conventions` grounding pass.
3. Develop each viable candidate through the candidate development role when
   delegation is available. Expand the candidate's user experience,
   implementation shape, risks, and convention interactions.
4. Use the grounding role to match developed candidates against the checklist
   and domain references.
5. Use the selection role to apply the two-stage selection sieve:
   - First reject candidates that fail mandatory expected-behavior gates. Show
     the violated gate for every rejection.
   - Then rank the remaining candidates by creativity, fit, and implementation
     practicality. Do not reject an unusual candidate merely because it is
     unusual.
6. Provide one adoption recommendation and any runner-up worth preserving.
7. Stop before implementation. Ask the user to confirm the selected direction
   before it becomes implementation scope or is handed to another workflow. In
   trusted proxy-selection mode, hand off only an AI-selected
   direction for later requirements or planning; do not call it user-confirmed
   and do not start implementation from it.

## Convention Grounding

Use all four grounding mechanisms when the mode includes conventions:

- Checklist-style expected behavior: concrete pass/fail expectations and edge
  cases.
- End-user role: delegated user, player, operator, or domain-user perspective
  when sub-agents are available.
- Domain/reference lookup: local project docs, existing implementation, official
  docs, upstream references, or domain material when relevant and accessible.
- User confirmation or orchestration proxy selection: a visible confirmation
  step before implementation when the checklist affects behavior or scope, or a
  trusted orchestration proxy selection that later requirements or planning must
  record as AI-selected input rather than human approval.

Keep mandatory gates narrow. A gate is mandatory only when missing it would
violate the user's goal, a domain convention, accessibility/safety expectation,
data contract, or a clear "normal users would expect this" behavior. Put taste,
polish, and speculative enhancements outside the mandatory gate.

Anchor convention checks in the current task, supplied references, local code,
and the user's stated domain. Do not carry preloaded niche examples,
third-party domain rules, platform rules, or fixture-specific checklists into
unrelated tasks.

## Output Contract

Prefer chat output. Create files only when the user explicitly asks for an
artifact.

Use this shape, omitting or marking skipped sections only when the selected mode
does not run that stage:

- Mode and delegation status: mode used and one of these delegation states:
  `confirmed` only when the output set includes independently recorded
  host/runner evidence and the response cites its artifact, field, tool block,
  task ID, or trace location; `unproven` when real calls may have happened but
  only assistant-authored final text can record them; or `unavailable/degraded`
  with the limitation and authorization status.
- Expected-behavior checklist: mandatory, optional, and unknown expectations, or
  `skipped by mode` for `diverge`.
- Candidates: grouped by `Practical` / `Unconventional` / `Challenging` for
  idea modes, or `not generated in conventions mode`.
- Selection: rejected candidates with violated gates, ranked surviving
  candidates, and adoption recommendation, or `skipped by mode`.
- Confirmation needed: the exact behavior checklist or selected direction the
  user must confirm before implementation starts, or the proxy-selected
  direction that a later requirements or planning phase must record as
  AI-selected input before any implementation scope exists.

Do not include private chain-of-thought from any agent. Summarize conclusions,
evidence, tradeoffs, and open questions.

## Handoff Boundary

This skill stops at confirmed direction or trusted orchestration proxy
selection. After user confirmation, hand the confirmed checklist or selected
candidate to implementation planning, plan execution, or ordinary coding as
appropriate. After a trusted orchestration proxy selection, hand the selected
checklist or candidate only to later requirements or planning as AI-selected
input. Without one of those outcomes, do not start implementation, create code,
stage files, commit, or claim the direction is approved.
