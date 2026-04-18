---
version: 1.1.0
name: vibe-planning-guard
description: Create verified requirements definitions, design comparisons, and implementation plans for vibe coding with strict stop conditions and risk-scaled output. Use when the user wants a spec, implementation plan, design outline, rewrite plan, replacement plan, restoration plan, or help comparing implementation approaches or structuring a concrete change before coding. Trigger when requirements are ambiguous, contradictory, or underspecified; when feasibility is unclear; when a real design branch needs tradeoff analysis; when existing behavior must be replaced or restored safely; or when the task is large enough that a structured plan is warranted. Do not trigger by default for tiny, already-clear edits, simple API-usage questions, or narrow code explanations unless the user explicitly asks for planning or risk review.
---

# Vibe Planning Guard

## Overview

Create plans that survive contact with reality. Treat the user as having only rough knowledge of the target behavior unless the workspace proves otherwise, and convert that rough request into a verified, option-aware plan instead of a confident guess.

When a real design branch exists, compare 2-3 viable options, recommend the safest path for the current phase, and keep verified facts separate from expert judgment.

This skill is for planning, not coding. Do not edit files or propose implementation as ready to start until the verification gate passes.

## Rule Precedence

Apply rules in this order when instructions compete:

1. `Non-Negotiable Rules`
2. `Workflow`
3. `Report Structure`
4. `Communication Style`

Interpret `stop` consistently: stop implementation for the current phase, keep planning alive, and output only proof-gathering, test-lock, or handoff material until the blocker is resolved.

## Scale the Process

Use the lightest safe mode for the task size and risk.

- `light`: Localized or low-blast-radius work such as a small refactor, a focused bug fix, a single integration touchpoint, or a narrow UI change in a known stack. Use a compact report, ask only 0-2 plan-changing questions after workspace scan, and compare options only when a real design branch remains. Still label every implementation-relevant assumption with an evidence class.
- `strict`: Multi-file or high-blast-radius work such as migrations, rewrites, replacement or restoration of behavior, external integrations, auth, billing, data model changes, performance work, security-sensitive flows, or anything with unclear feasibility. Use the full report, ask only questions that resolve a blocker, and use structured comparison when ambiguity affects behavior, tests, data, or external contracts.
- Choose `strict` immediately when auth, billing, security, migrations, external contracts, restoration work, or any `high` or `critical` `Unproven` item is involved.
- Choose `strict` immediately when a behavioral equivalence analysis contains any `Unknown` dimension or when a `must preserve` dimension has been reclassified to `in scope for change` during analysis.
- Stay in `light` only when the slice is localized, the main behavior contract is already mostly clear, and any remaining uncertainty is deferred or non-blocking for the current phase.
- If the choice feels borderline, choose `strict` and keep the report concise rather than weakening the safety bar.

Do not use `light` mode as an excuse to skip verification. It only reduces report weight and encourages tighter scoping. The verification bar does not change across modes.

## Non-Negotiable Rules

- Assume missing detail, hidden constraints, and false certainty are the default failure modes.
- Include only actions whose feasibility is supported by `Primary source` or `Local reproduction`.
- Label every fact, assumption, and dependency with exactly one evidence class: `Primary source`, `Local reproduction`, or `Unproven`.
- State something as fact only when it is backed by `Primary source` or `Local reproduction`.
- When recommending an option, keep verified facts, `Unproven` blockers, and expert judgment visibly separate.
- When a request replaces, restores, rolls back, or rewrites existing behavior, inspect a previously-good commit before planning the change. If no known-good commit can be verified, mark that gap as `Unproven` and stop.
- When a change touches existing behavior — whether through replacement, refactoring, migration, internal implementation change, or explicit specification change — perform the behavioral equivalence analysis from `references/behavioral-equivalence-analysis.md`. Separate each comparison dimension into `in scope for change` or `must preserve`, classify every dimension explicitly, and include the analysis in the plan output. If any `must preserve` dimension is found to be non-equivalent, stop and report to the user before continuing. If any dimension is classified `Unknown`, the change is blocked until proof is provided.
- Define tests before implementation steps. For discovery-only phases, define proof checks and exit criteria before any spike or experiment.
- If even one implementation-relevant item remains `Unproven` for the current phase, stop after the plan. Do not authorize implementation. Shrink the current slice if needed until the current phase has zero `Unproven` implementation assumptions.

## Workflow

1. Ground the request in the workspace first.
   - Read the relevant code, configs, tests, schemas, docs, commit history, and errors before asking the user.
   - Prefer local inspection and reproducible commands over memory.
   - Use primary sources for unstable facts such as framework behavior, product limits, versions, APIs, or policies.
   - If the request spans independent subsystems, call that out and propose a decomposition before planning both at once.
   - Prefer established local patterns over inventing a fresh structure for the current slice.
2. Choose the smallest safe planning slice.
   - Separate today's actionable slice from later phases.
   - Move non-blocking or cosmetic uncertainty into deferred decisions when it does not affect the current code path, test design, or behavior contract.
   - Move design branches that do not affect the current phase into deferred decisions instead of bloating the current plan.
   - If the task is large, split it into discovery, test-lock, and implementation phases instead of forcing one giant plan.
3. Build a fact table.
   - Turn requirements, assumptions, constraints, and inferred dependencies into a table with evidence class, source, and impact.
   - If the right evidence class is unclear, read `references/evidence-rubric.md`.
4. Surface ambiguity and design branches explicitly.
   - First list every ambiguous or conflicting requirement and offer alternatives that clarify behavior.
   - After the requirements are clarified, compare 2-3 viable design options only when a real design branch still remains.
   - For each option, include tradeoffs, blocking unknowns, and YAGNI impact for the current phase.
   - Recommend an option only when the decision inputs are sufficiently proven.
   - Recommendation may include expert judgment, but present `Why (verified facts)` separately from `Why (judgment)`.
   - If key decision inputs are still missing, do not force a recommendation. Give a `Recommended proof path` instead.
5. Triage `Unproven` items.
   - For each `Unproven` item, record risk level: `critical`, `high`, `medium`, or `low`.
   - Record whether it affects feasibility, behavior, data, integration, performance, security, UX, or cosmetic detail.
   - Record whether it blocks discovery, test design, or implementation for the current phase.
   - Use the risk level to order work and choose `light` versus `strict`, but do not treat risk as permission to implement around an `Unproven` blocker.
   - If a `light` plan contains any `high` or `critical` `Unproven` item, upgrade the report to `strict`.
6. Use the recovery flow for replacement or restoration.
   - Read `references/change-recovery-checklist.md`.
   - Identify the current behavior, target behavior, and last known-good implementation.
   - Inspect the code and tests in that historical state before describing any replacement or restoration plan.
7. Lock proof checks and tests.
   - In discovery phases, define proof checks, spike exit criteria, and the evidence needed to clear each blocker.
   - In implementation phases, define acceptance tests, regression tests, and important failure cases before implementation steps.
   - Align the proof checks and tests with the chosen option or proof path.
   - When a behavioral equivalence analysis has been performed, include test scenarios for every dimension classified as `Equivalent` or `Changed (in scope)`. A test plan that only verifies the immediate observable result is incomplete. Persistence round-trips, lifecycle events, external contract guarantees, and resource cleanup must be covered when those dimensions are relevant.
   - If any dimension from the behavioral equivalence analysis is classified `Unknown`, add a proof check specifically for that dimension before implementation.
   - If the behavior is not yet clear enough to test, stay in discovery. Do not smuggle implementation into the discovery phase.
8. Apply the verification gate.
   - Use `references/design-exploration-rules.md` as a final self-check for comparison discipline, scope control, recommendation framing, and blocker visibility.
   - If any item is still `Unproven`, stop at the plan and say implementation must not begin.
   - If all implementation-relevant items for the current phase are proven, deliver the plan and note that implementation may begin only in a later execution step.

## Evidence Classes

- `Primary source`: Official documentation, authoritative specifications, upstream source code, vendor docs, user-provided source material, or a known-good historical implementation. Use this for product claims, framework rules, and intended behavior.
- `Local reproduction`: Behavior confirmed in the current environment by reading local code, running non-mutating checks, reproducing a failure, or observing a passing test locally.
- `Unproven`: Memory, inference, secondhand summaries, forum advice, stale docs, unexecuted hypotheses, or missing historical evidence.

Never upgrade `Unproven` to fact. Convert it into a question, a discovery step, or a blocker.

## When Primary Sources Are Unavailable

- Say exactly why the primary source is unavailable: network restriction, NDA boundary, missing access, removed docs, or absent vendor material.
- Fall back to checked-in specifications, vendored source, user-provided documents, release artifacts, and local reproduction where possible.
- If none of those can prove the claim, keep it as `Unproven`.
- Do not substitute memory or generic internet recollection for a missing primary source.

## Expert Input

Treat expert intuition as useful input for option generation, risk ranking, and spike design, but not as established fact by itself.

- Record expert judgment as an `Unproven` lead until a primary source or local reproduction backs it.
- Use expert input to decide the fastest proof path.
- Use expert input to shape recommendations only after separating verified facts from judgment.
- Do not use expert input alone to justify implementation steps.

## User-Acknowledged Risk

If the user explicitly says they want to proceed despite an `Unproven` blocker, record that as `Acknowledged risk` for handoff, not as proof.

- Keep the evidence class as `Unproven`.
- Record the user rationale, impact area, owner or decision-maker, and revisit trigger.
- Keep the stop condition unchanged inside this skill. `Acknowledged risk` documents a conscious exception request; it does not authorize implementation here.
- Use this when the user is intentionally accepting delivery, schedule, or business risk and needs a precise record of what remains unproven.

## Planning Rules Under Uncertainty

- Do not include speculative implementation steps whose success depends on an `Unproven` claim.
- Replace speculative implementation with the minimum proof-gathering task needed to turn that claim into `Primary source` or `Local reproduction`.
- If feasibility itself is unproven, stop at the investigation plan. Do not draft production code steps behind it.
- If two verified sources disagree, report the conflict instead of choosing silently.
- If a decision is genuinely deferrable and does not affect the current phase, mark it as a deferred choice instead of letting it bloat the blocker list.
- Prefer the simplest proven path that serves the current phase over a richer but speculative design.
- Split work so each current-phase unit has one clear purpose, boundary, and test surface.
- When recommending an option, make it obvious which part is verified input and which part is engineering judgment.

## Iterative Planning

Use phased planning when a full end-to-end plan would be blocked or too heavy.

At the start of every phase, revisit deferred choices from the previous phase. Either prove them, keep them deferred with a named next-review point, or promote them to blockers.

1. `Discovery phase`
   - Prove feasibility, gather missing sources, inspect prior behavior, and reduce uncertainty.
   - Output only proof tasks, proof checks, and decision gates.
   - Exit discovery only when the current slice has a stated behavior contract, a plausible approach backed by `Primary source` or `Local reproduction`, and no remaining unknowns that block writing tests for this slice.
2. `Test-lock phase`
   - Once the current slice is understood, define the tests and acceptance criteria needed before coding.
   - Exit test-lock only when the tests, proof checks, and acceptance criteria are specific enough that another engineer could implement against them without inventing the missing behavior.
3. `Implementation phase`
   - Only after the current slice has no `Unproven` implementation blockers.

If discovery stops reducing uncertainty, shrink the slice, gather a missing source, or ask the minimum blocking question. Do not loop indefinitely on vague research.

MVP thinking is allowed only by shrinking scope until the MVP slice itself is verified. Do not label a speculative slice as safe just because it is small.

## Report Structure

Choose the lightest format that still makes blockers obvious.

Use this compact structure for `light` mode. Omit `Recommended approach or proof path` if no real design branch exists:

```markdown
# [Short plan title]
## Goal

## Verified facts
- Item — Evidence — Source

## Recommended approach or proof path
- Option or proof path:
- Why (verified facts):
- Why (judgment):

## Open questions, contradictions, deferred choices, or future-phase unproven items
- Item — Status: `contradiction` | `deferred` | `unproven` | `acknowledged-risk`
- Risk:
- Next proof or review point:

## Proof checks and test plan
- Proof checks or tests required before coding

## Next steps
1. [Discovery or implementation-prep steps only]

## Stop condition
- State explicitly whether implementation is blocked or allowed.
```

Use this full structure for `strict` mode:

```markdown
# [Short plan title]
## Goal and success criteria

## Verified facts
| Item | Evidence | Source | Why it matters |

## Ambiguities and contradictions
- Issue:
- Options:
- Recommended option or proof path:
- Why (verified facts):
- Why (judgment):
- Blocking proof:

## Unproven items and required proof
- Item:
- Risk:
- Phase relevance:
- Missing proof:
- Fastest safe way to prove it:
- Next review point:

## Test plan
- Acceptance tests
- Regression tests
- Negative or edge cases

## Implementation plan
1. [Only proven steps]
2. [Only proven steps]

## Stop condition
- State explicitly whether implementation is blocked or allowed.
```

Include the following section in both modes when the change touches existing behavior. Once this analysis has been performed, the section must remain in the output regardless of subsequent mode changes, scope reclassification, or any other plan updates.

Use this compact equivalence section for `light` mode:

```markdown
## Behavioral equivalence (include when the change touches existing behavior)
| Dimension | Scope | Classification | Evidence | Rationale (if Not applicable or Changed) | Test or proof check |

For `Changed (in scope)` dimensions (required in both modes):
- Requirement or user approval reference:
- Changed success criteria:
- Impact explanation:
- Corresponding test:
```

Use this full equivalence section for `strict` mode:

```markdown
## Behavioral equivalence analysis (include when the change touches existing behavior)
| Dimension | Scope (in scope for change / must preserve) | Classification | Evidence or source | Rationale (for Not applicable / Changed) |

For `Changed (in scope)` dimensions (required in both modes):
- Requirement or user approval reference:
- Changed success criteria:
- Impact explanation:
- Corresponding test:
```

The `Changed (in scope)` metadata (requirement or user approval reference, changed success criteria, impact explanation, corresponding test) is required regardless of mode. Do not omit it in `light` mode.

If any `Unproven` item exists, the `Implementation plan` section may contain only proof-gathering and test-preparation work. Do not include production changes that assume the missing proof will succeed.

If the user explicitly accepts a remaining blocker, append this optional section in either mode:

```markdown
## Acknowledged risks for handoff
- Item:
- Why it remains unproven:
- User rationale:
- Impact area:
- Owner or decision-maker:
- Revisit trigger:
```

This section documents the exception request; it does not change the stop condition inside this skill.

## Communication Style

- Use plain language first. Introduce jargon only when needed and define it once.
- Explain why each alternative exists and what would make one option safer than another.
- Make blockers obvious. Do not bury them at the end.
- Ask only the minimum blocking question after exploration is exhausted.
- If several questions resolve the same decision, they may be batched into one turn.
- Do not ask about defaults that can be chosen safely for the current phase.
- Keep blockers adjacent to the recommendation, not pages away from it.
- Be explicit about what is known, how it was verified, and what is still missing.

## References

- Evidence classes and allowed phrasing: `references/evidence-rubric.md`
- Replacement, restoration, and rollback checks: `references/change-recovery-checklist.md`
- Design comparison rules, recommendation framing, and self-checks: `references/design-exploration-rules.md`
- Behavioral equivalence analysis for changes touching existing behavior: `references/behavioral-equivalence-analysis.md`
