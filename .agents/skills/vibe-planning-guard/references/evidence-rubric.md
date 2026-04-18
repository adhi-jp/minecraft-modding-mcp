# Evidence Rubric

Use this file when the correct evidence label is unclear or when you need to decide how strongly you can phrase a claim.

## Evidence Classes

| Class | Counts as evidence | Does not count | Safe phrasing |
| --- | --- | --- | --- |
| `Primary source` | Official docs, authoritative specs, upstream code, vendor docs, user-provided source material, known-good historical implementation | Blog summaries, forum posts, memory, guesses | "Confirmed by the primary source ..." |
| `Local reproduction` | Local code inspection, reproduced error, observed runtime behavior, passing or failing local check, verified config in the workspace | A command you did not run, a test you assume exists, a path you did not inspect | "Observed locally in ..." |
| `Unproven` | Memory, inference, indirect reports, stale screenshots, missing history, untested feasibility | Anything not directly verified | "Unproven; requires verification before implementation." |

## Decision Rules

- Label the specific claim, not the whole task. A single plan may contain multiple evidence classes.
- Prefer the narrowest honest label. If only part of a statement is verified, split the statement.
- Treat feasibility as proven only when the exact version, variant, or environment has been covered by `Primary source` or `Local reproduction`.
- Treat behavioral equivalence between old and new code as proven only when every dimension defined in `references/behavioral-equivalence-analysis.md` has been individually classified and verified. Matching immediate output alone does not prove equivalence across other dimensions. Discovering that a `must preserve` dimension is not equivalent is a stop signal, not a classification decision.
- If a historical implementation is used as evidence, confirm that it was actually known-good. A random old commit is not enough.
- If the only support is indirect or secondhand, the item remains `Unproven`.

## When Primary Sources Are Not Reachable

- Record why the primary source could not be checked: network restriction, permissions, NDA boundary, deleted docs, or missing vendor access.
- Check nearby substitutes in this order:
  1. Checked-in specifications, ADRs, or product docs
  2. Vendored source or generated client code
  3. Release notes, artifacts, or archived copies already available locally
  4. Local reproduction in the current environment
- If none of these establish the claim, keep the item `Unproven`.
- Never present a fallback source as if it were a primary source.

## Unproven Triage

Every `Unproven` item should also carry these planning attributes:

- `risk`: `critical`, `high`, `medium`, or `low`
- `impact_area`: such as `feasibility`, `behavior`, `data`, `integration`, `performance`, `security`, `ux`, or `cosmetic`
- `phase_relevance`: whether it blocks `discovery`, `test design`, or `implementation`

Use these attributes to order the work and size the report. They do not upgrade the evidence class or make an item safe to implement around.

## Risk Level Guide

- `critical`: The current phase cannot proceed safely without proving this item. Typical cases: unproven feasibility for the chosen slice, unknown external contract, irreversible migration risk, auth or billing uncertainty, data loss risk, or security-sensitive behavior with unclear guarantees.
- `high`: The item may break the primary workflow or create a major regression, but blast radius is more bounded or rollback is straightforward.
- `medium`: The item affects a secondary workflow, a localized integration detail, or non-catastrophic behavior where rollback and containment are easy.
- `low`: The item is cosmetic, presentation-only, or otherwise deferrable without affecting safety, data, the core behavior contract, or test design.

Apply the guide in context:

- Unproven feasibility for the current implementation slice is usually `critical`.
- Cosmetic uncertainty is usually `low`, unless it affects accessibility, compliance, contractual requirements, or user trust in a material way.
- If the team could safely ship the current phase without the answer and revisit it later, the item is rarely `critical`.

## Conflicting Evidence

- If two primary sources disagree, report the conflict and stop short of a recommendation until it is resolved.
- If local reproduction conflicts with documentation, report both. Prefer the local observation for the current workspace behavior, but do not generalize beyond it.
- If historical behavior conflicts with the current codebase, treat the difference as a migration or regression question, not as a settled fact.

## Claim Discipline

- Use declarative language only for `Primary source` and `Local reproduction`.
- Use conditional or blocking language for `Unproven` items.
- Never hide an `Unproven` assumption inside a confident implementation step.

## Acknowledged Risk

- `Acknowledged risk` is a reporting status, not an evidence class.
- Use it only when the user explicitly accepts that an item remains `Unproven`.
- Keep the underlying evidence label as `Unproven`.
- Record the reason for acceptance, impact area, owner or decision-maker, and revisit trigger.
- Do not use `Acknowledged risk` to justify factual claims or to authorize implementation inside this skill.

## Expert Input

- Expert intuition, past experience, or team folklore is useful for generating options and choosing a proof strategy.
- Unless it is backed by a primary source or local reproduction, label it `Unproven`.
- Prefer phrasing such as "expert hypothesis" or "team assumption" over factual wording.

## Examples

- "The API supports bulk update in version 3.4" is `Primary source` only if the version 3.4 vendor docs or upstream code confirm it.
- "This workspace already has a feature flag for the flow" is `Local reproduction` only if the config or code was actually inspected.
- "We can probably restore the old behavior by reverting the service layer" is `Unproven` until a known-good commit and its tests are checked.
- "A senior engineer expects this caching pattern to work here" stays `Unproven` until the relevant docs or a local reproduction back it.
- "The new API produces the same visible result as the old one" is `Unproven` for full behavioral equivalence until ownership semantics, persistence behavior, lifecycle behavior, and external contract guarantees have been separately verified against `Primary source` or `Local reproduction`.
