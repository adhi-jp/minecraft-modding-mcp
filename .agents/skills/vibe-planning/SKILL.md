---
version: 2.0.0
name: vibe-planning
description: >
  Use when the user wants planning before coding: plan mode, create a plan,
  implementation plan, specification, acceptance criteria, test plan, vibe
  coding, requirements clarification, what to build first, or equivalent
  planning requests in any language. Also use for rough, ambiguous,
  feasibility-sensitive, non-technical, or not-yet-implementable coding
  requests.
---

# Vibe Planning

## Overview

Turn rough vibe-coding intent into an implementation plan another engineer or
agent can execute without inventing missing behavior. Treat the user's request
as valuable intent, not verified fact: preserve what they want, prove what can
be proven, and make uncertainty visible.

This skill is independent. Do not assume another planning skill or guard is
available.

## Output Language and Artifact

Resolve the user-facing summary language before drafting the plan:

1. Explicit user instruction in the current request.
2. `VIBE_PLANNING_OUTPUT_LANG`, if the environment is safely readable. If the
   prompt itself includes an assignment-like value such as
   `VIBE_PLANNING_OUTPUT_LANG=English`, treat it as the user's explicit setting
   for that request.
3. Agent or project configuration, if exposed in the current environment,
   system/developer instructions, project instructions, or already-loaded local
   config.
4. The conversation language.

Do not run broad discovery just to find a language setting. If a configured
language cannot be read, treat it as unset and continue. Keep file paths, code
identifiers, API names, commands, field names, error messages, and quoted source
material in their original language unless the user explicitly asks for
translation.

Write the full implementation plan as a Markdown artifact by default, then give
the user only a concise summary in the resolved user-facing language.
Use this file path selection order:

1. A user-specified local path.
2. An existing project convention for plans or specs if it is obvious from the
   workspace, such as `plans/`, `docs/plans/`, or `specs/`.
3. `plans/YYYY-MM-DD-<goal-slug>-implementation-plan.md` at the workspace root,
   using the current local date and a short lowercase ASCII slug.

Do not overwrite an existing plan file. If an explicit user path already exists,
ask before replacing it; use a non-destructive sibling only when the user allowed
that behavior. For generated default names, append a numeric suffix such as `-2`
on collision. Do not modify `.gitignore` only because a plan artifact was
created.

The artifact is for later agents and implementers. Use fixed English section
headings and concise implementation-oriented English prose for structure.
Preserve user-authored goals, requirements, in-scope and out-of-scope
statements, quoted source material, domain vocabulary, product labels,
identifiers, paths, commands, errors, API names, and field names in their
original language. When an English operational paraphrase is useful, place it
after the original wording instead of replacing the original.

After writing the file, reply with only the essentials in the resolved
user-facing language:

- Plan file path.
- Current slice.
- Proceed condition.
- Key `Unproven`, `Accepted risk`, blocker, or decision items.
- The next action needed from the user, if any.

Do not paste the full plan into chat unless file writing is unavailable, unsafe,
or explicitly declined. If no file was written, state the reason and provide the
complete plan artifact in the reply using the same English artifact structure.

## Core Rules

- Ground the plan in primary sources or actual investigation before asking the
  user to decide. Read relevant local code, tests, configs, schemas, docs, logs,
  issue text, or official documentation first.
- Use official docs, upstream source, vendor documentation, standards, or
  user-provided source material for claims about external systems. Use local
  reproduction or direct repository inspection for claims about the current
  workspace.
- Do not present memory, inference, forum summaries, or unchecked assumptions as
  fact. Mark them as `Unproven`.
- Do not accept user claims blindly. If a claim is false, stale, unsupported, or
  infeasible, state the evidence and propose the closest viable alternative.
- Respect the user's requested outcome as far as reality allows. When a request
  cannot be implemented literally, preserve the intent and adjust the mechanism.
- When the user asks for broad UX improvements, make the first slice complete
  or improve an existing verified surface before adding adjacent unverified
  channels, providers, modes, or settings.
- Ask questions only for intent, tradeoffs, permissions, business rules, or
  missing context that investigation cannot determine.
- For non-technical users, explain choices in plain language and translate
  technical consequences into product or workflow impact.
- Define acceptance criteria and tests before implementation steps.
- Do not invent numeric limits, thresholds, timing windows, quotas, or product
  constants. Use values only when they come from user requirements, local
  evidence, primary sources, or accepted risk; otherwise label the value
  `Unproven` and make proof or a product decision precede implementation.
- For editable UI plans, include observable state transitions in the acceptance
  criteria and tests: save, cancel/reset or explicit no-cancel behavior, pending
  state, success feedback, validation failure, and error recovery when relevant.
- For narrow changes inside profile, account, settings, admin, billing, or other
  broad surfaces, explicitly name adjacent features that are not in the current
  slice when a later implementer could plausibly expand into them. Include
  destructive or high-risk adjacent account actions, such as account deletion,
  only as out of scope unless the user asked for them.
- If implementation proceeds with an `Unproven` assumption, require explicit
  user risk acceptance and keep the item labeled as `Accepted risk`; never
  convert it into verified fact.

## Evidence Labels

Use these labels in the plan when a claim affects scope, feasibility, behavior,
tests, or implementation order:

- `Primary source`: official documentation, authoritative specification,
  upstream source, vendor docs, user-provided source material, or a known-good
  historical implementation.
- `Local investigation`: repository inspection, non-mutating command output,
  reproduced behavior, existing tests, configs, schemas, or logs from the
  current workspace.
- `Unproven`: memory, inference, secondhand claims, stale docs, unchecked user
  claims, missing access, or hypotheses.
- `Accepted risk`: an `Unproven` item the user explicitly chose to proceed with
  after the impact was explained.

Every `Unproven` or `Accepted risk` item must include impact, the fastest proof
path, and where it must be revisited.

## Method Selection

Choose the lightest method that still protects the work:

| Situation | Preferred method |
| --- | --- |
| New feature | Spec-driven |
| Complex business logic | Spec-driven + test-driven |
| Bug fix | Test-driven |
| Existing-code refactor | Test-driven |
| UI/UX implementation | Spec-driven |
| API, database, auth, permissions, or external contracts | Spec-driven + test-driven |
| Small function | Test-driven is usually enough |
| Larger feature development | Spec-driven is close to required |

Use the full spec-driven + test-driven flow when behavior is complex, expensive
to change later, or crosses data, security, permission, API, billing,
persistence, or external-service boundaries. Use a compact version for small,
localized work.

## Planning Workflow

1. **Classify the work**
   - Identify whether the task is a feature, bug fix, refactor, UI/UX change,
     integration, API/DB/permission change, or small local implementation.
   - Choose spec-driven, test-driven, or combined planning from the table.
   - Split large requests into the smallest useful current slice.
   - If local evidence shows an existing partial surface and the user mentions
     adjacent future capabilities, make the first slice complete or improve that
     surface unless a verified requirement makes an adjacent capability part of
     the current outcome.
2. **Investigate before asking**
   - Inspect the workspace and primary sources relevant to the current slice.
   - Record facts with evidence labels.
   - If primary sources are unavailable, say why and keep dependent claims
     `Unproven`.
3. **Clarify intent**
   - Ask only plan-changing questions that cannot be answered from evidence.
   - For non-technical users, offer concrete choices with consequences instead
     of abstract architecture terms.
4. **Write or refine the specification**
   - State the goal, users, in-scope behavior, out-of-scope behavior, constraints,
     and success criteria.
   - Review the specification for ambiguity, contradiction, missing states,
     hidden dependencies, and unverifiable assumptions.
5. **Define acceptance criteria**
   - Convert the clarified specification into observable pass/fail criteria.
   - Include negative cases, permissions, failure states, empty states, migration
     or compatibility expectations, and UX states when relevant.
   - For editable forms or settings screens, explicitly decide whether cancel,
     reset, or navigation-away behavior is in scope; when it already exists,
     preserve it with acceptance criteria and tests.
6. **Design tests before implementation**
   - Derive tests from acceptance criteria.
   - For bug fixes, include a failing regression test or a reproduction proof
     before production-code changes.
   - If the reported symptom may depend on unverified callers, configuration,
     runtime state, external behavior, or data shape, put the fastest isolation
     step before implementation steps, even when a local defect is also visible.
   - For refactors, include equivalence checks that prove behavior is preserved.
   - For UI, include interaction, state, responsive layout, and accessibility
     checks when relevant.
7. **Plan implementation**
   - Use only steps supported by `Primary source`, `Local investigation`, or
     explicit `Accepted risk`.
   - Preserve local conventions and existing architecture unless evidence shows
     they are the source of the problem.
   - Put proof-gathering steps before implementation steps when feasibility is
     still unproven.
8. **Plan verification and review**
   - Include test, lint, type-check, build, manual smoke, screenshot, diff review,
     or rollout checks appropriate to the stack.
   - Include a final diff-review step that checks the result against the
     specification and acceptance criteria.
   - For multi-slice plans, include commit checkpoints after each independently
     verifiable phase or slice. Each checkpoint states the intended scope,
     required verification, and a proposed standalone Conventional Commit
     message that names the concrete change. Do not plan commits for
     discovery-only, unverified, or work-in-progress states.
9. **Prepare the implementation handoff**
   - Include a short handoff that starts with "When implementing this plan" so
     pasted plans remain self-contained execution requests.
   - Tell the implementer to treat the document as authoritative, re-check local
     facts before editing, follow the acceptance criteria and test plan,
     implement only the current in-scope slice, and stop on a blocked
     `Proceed condition` or contradictory local evidence.

## Handling Incorrect or Impossible Requests

When the user's requested mechanism is wrong or impossible:

1. Restate the user's likely underlying goal.
2. Cite the verified source or local evidence that blocks the literal request.
3. Explain the risk in practical terms.
4. Offer the closest viable alternative.
5. Ask for a decision only if the alternatives change product behavior, cost,
   timeline, data handling, security posture, or user experience.

Do not bury impossibility inside a generic risk list. Put it near the decision
it affects.

## Accepted-Risk Branch

If the user explicitly chooses to continue with an unproven assumption:

- Record the exact assumption.
- Record the user's acceptance and rationale.
- Record the impact area: feasibility, behavior, data, integration, performance,
  security, UX, cost, or schedule.
- Keep the evidence label as `Accepted risk`.
- Include the fastest proof path and revisit trigger.
- Make implementation steps conditional where the unproven assumption could
  invalidate the plan.

Never use accepted risk for irreversible, destructive, unsafe, illegal, or
credential-exposing actions. Those require proof or a safer alternative.

## Standard Plan Artifact

Use this structure for the implementation-ready plan file. Keep it compact for
small tasks, but preserve the order: requirements and tests come before
implementation.

```markdown
# [Plan title]

## Goal
- [What the user wants to accomplish and for whom]

## Verified facts and sources
| Claim | Evidence | Source | Impact |
| --- | --- | --- | --- |

## Requirements
- In scope:
- Out of scope:
- Constraints:

## Ambiguities, questions, and decisions
- Item:
- Options or decision:
- Evidence:
- Recommended path:

## Acceptance criteria
- [Observable pass/fail criterion]

## Test plan
- Acceptance tests:
- Regression tests:
- Negative and edge cases:
- Manual or visual checks:

## Implementation plan
1. [Proof or setup step, if needed]
2. [Implementation step]
3. [Verification and diff-review step]

## Commit checkpoints
- [For multi-slice plans only: checkpoint scope, required verification, and
  proposed standalone Conventional Commit message. Omit this section for
  single-slice or discovery-only plans.]

## Risks and unproven items
- Item:
- Evidence label: `Unproven` | `Accepted risk`
- Impact:
- Fastest proof path:
- Revisit trigger:

## Implementation handoff
- When implementing this plan, treat this document as authoritative. Re-check
  local facts before editing, follow the acceptance criteria and test plan,
  implement only the current in-scope slice, and stop if the `Proceed condition`
  is blocked or local evidence contradicts the plan.

## Proceed condition
- [State whether implementation is ready, conditional on accepted risk, or
  blocked pending proof/user decision.]
```

For discovery-only phases, replace `Implementation plan` with `Discovery plan`
and list proof tasks, exit criteria, and the next decision point.

## Quality Checklist

Before finalizing the plan, check that:

- Discoverable facts were investigated before asking the user.
- Technical jargon is explained or avoided when the user may be non-technical.
- The full plan was written to a durable Markdown artifact, or the fallback
  reason for chat-only output is stated.
- The plan artifact uses stable English section headings and preserves
  user-authored intent, requirements, quoted material, and domain terms in their
  original language.
- The user-facing reply is a concise summary in the resolved language and does
  not duplicate the full artifact unless file output was unavailable or declined.
- Every implementation-affecting claim has an evidence label.
- False or infeasible requirements are challenged with evidence and alternatives.
- Acceptance criteria are observable.
- Tests come before implementation steps.
- Implementation steps do not rely on unlabeled assumptions.
- The implementation handoff is present, self-contained, and does not name
  another skill.
- Accepted risks are explicit, scoped, and revisitable.
- The user-facing summary language follows the configured precedence.
