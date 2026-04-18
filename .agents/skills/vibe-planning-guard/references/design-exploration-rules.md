# Design Exploration Rules

This file explains how to compare design options without weakening the evidence bar.

## Precedence

- `SKILL.md` defines when to compare options, when to stop, and what the report must contain.
- `references/evidence-rubric.md` defines how to classify facts and uncertainty.
- This file defines how to frame design exploration, recommendation, and self-checks inside those constraints.

## When to Compare Options

- Compare options only when a real design branch remains after clarifying requirements.
- Do not manufacture options when the existing architecture, local patterns, or current-phase scope already imply one path.
- Cap comparison at 2-3 viable options.
- Keep the comparison scoped to the current phase. Do not compare future-phase expansions that are not actionable today.

## How To Recommend Safely

- Recommendation inputs should be explicit: verified facts, current constraints, local patterns, known blockers, and scope.
- Recommendation may include engineering judgment, but it must be visibly separated from verified facts.
- If key decision inputs are still missing, give a `Recommended proof path` instead of a forced recommendation.
- Do not let a polished recommendation hide an `Unproven` blocker.

Use this pattern when you recommend an option:

```markdown
- Recommended option:
- Why (verified facts):
- Why (judgment):
- Blocking proof:
```

`Why (verified facts)` should point to evidence-backed constraints, existing architecture, proven behavior, or local patterns.

`Why (judgment)` should explain the engineering preference being applied, such as coordination cost, operational simplicity, or reduced long-term coupling.

## YAGNI Filter

- Prefer the simplest proven path that serves the current phase.
- Remove optional abstractions, speculative future-proofing, and side quests that are not needed to test or ship the current slice safely.
- If two options are both viable, prefer the one that adds the least unverified surface area.

## Scope Decomposition Rule

- Split independent subsystems before planning details.
- Keep each current-phase work unit centered on one clear objective.
- Make boundaries explicit enough that another engineer can tell what is inside the slice and what is deferred.
- Prefer changes whose interface and test surface can be described without reading their internals.

## Plan Self-Check

Before finalizing the plan, ask:

- Is there a real design branch here, or am I comparing options out of habit?
- Are verified facts and engineering judgment clearly separated?
- Are blockers visible next to the recommendation?
- Did I keep the plan bounded to the current phase?
- Do the proof checks and tests line up with the chosen option or proof path?
- If this plan touches existing behavior, did I classify every equivalence dimension explicitly? Did I separate `in scope for change` from `must preserve` dimensions? Is the comparison visible in the output? Does each relevant dimension have a corresponding test or proof check? If a `must preserve` dimension turned out to be non-equivalent, did I stop and consult the user?
