---
version: 1.0.2
name: review-fix-cascade-guard
description: Use when applying user-selected review findings after scope triage, especially inside codex-review-cycle or after a standalone Codex adversarial review, and a line-scoped fix may create follow-on valid findings. Do not use for ordinary edits, plan drafting, single-shot lint, no-review contexts, or generic refactor checklists.
---

# Review Fix Cascade Guard

## Overview

A containment guard between a review tool's user-selected findings and the agent's `Edit`/`Write` calls. Line-scoped fixes recreate the cascade pattern: cycle 1 patches the reported line, cycle 2 raises a new valid finding the cycle 1 fix exposed. The recurring shapes the cascade takes are enumerated in §Phase 2 (13 archetypes).

The guard does not auto-fix. It restates the invariant in path-neutral terms, enumerates the sibling paths the same invariant applies to, picks the smallest envelope that closes the predicted next-cycle finding, and emits a `gate_status` enum. The caller (`codex-review-cycle` or a manual review/fix loop) reads `gate_status` and applies edits ONLY when it is `closed` or `accepted-residual`. The other three statuses block edits and force a deferral, split, or override-to-accepted-residual transition through `AskUserQuestion`.

After every selected finding has its per-finding envelope, a Phase 5.5 batch reconciliation pass runs over the combined fix set so envelopes that touch a shared surface (same file region, same caller schema, same doc section, same test) are ordered, split, doc-cascade deduped, or paused before the agent applies any edit. The batch produces its own `<batch_reconciliation>` carry record consumed by the next cycle.

If the skill is executed manually because the harness cannot invoke it, the manual fallback must still produce the Phase 3 sibling-path matrix and Phase 5 validation evidence. A recorded `manual-fallback` receipt without that evidence is a bypass, not a closed guard.

The skill's bias toward residual + deferral over scope expansion is documented in §Key Design Constraint at the bottom of the file.

## Language

All user-facing output is rendered in the user's language (the language the user has been using in the conversation, or as configured in the Claude Code system-level language setting).

**Translate into the user's language:**

- Section headings (`Cascade Guard`, `Invariant`, `Archetypes`, `Sibling-path matrix`, `Fix envelope`, `Validation`, `Likely next-cycle finding`, `Phase 5.5 batch reconciliation`, `Phase 6 completion note`)
- Free-text fields the skill authors: invariant prose, sibling-path descriptions, fix envelope rationale, validation prose, next-cycle prediction prose, residual descriptions
- `AskUserQuestion` `question`, `header`, and option `label` / `description` fields
- Override-to-accepted-residual transition prompts

**Keep verbatim (do NOT translate), regardless of user language:**

- `gate_status` enum values: `closed`, `accepted-residual`, `invariant-unknown`, `high-cascade-risk`, `needs-user-decision`
- Archetype identifiers: `path-coverage`, `state-persistence`, `boundary-binding`, `identity-contract`, `doc-cascade`, `interaction-modality`, `silent-violation`
- Codex `title` and `recommendation` field values when quoted
- File paths, git refs, identifiers (`F<n>`, `cycle N`)
- XML element names in carry records (`<invariant>`, `<surfaces_checked>`, `<residuals>`, `<next_cycle_attack>`, `<batch_reconciliation>`, `<shared_surfaces>`, `<application_order>`, `<splits>`, `<combined_prediction>`, `<batch_gate_status>`)

## When to Use

Use this skill ONLY when:

- The user (or `codex-review-cycle`) is about to apply one or more review findings, AND
- Each finding has been classified as `must-fix` or `minimal-hygiene` by `review-scope-guard` (or by the user manually if scope-guard is not in the loop), AND
- The agent has the option to call `Edit`/`Write` on the affected files.

Do NOT use this skill when:

- The user is drafting a plan, exploring a design, or doing ordinary code editing unrelated to a review pass — use `vibe-planning-guard` or proceed without a guard.
- A finding has been classified `reject-out-of-scope` or `reject-noise` — those findings are not edited; the guard would emit no useful output.
- The user has not yet run a review pass — there is no finding to envelope.
- The agent is performing a generic refactor or feature add — the guard's archetype matrix is calibrated for review-fix containment, not greenfield design.

**Standalone use vs `codex-review-cycle` integration.** The primary integration target is `codex-review-cycle`, which feeds findings, drives the multi-cycle loop, and consumes Phase 6 notes plus the `<batch_reconciliation>` carry record into the next cycle's `<previous_fixes>`.

Standalone use — the user invokes the guard directly after a one-shot codex review or any other source of findings — only exercises Phase 0–5 per-finding: `gate_status` is returned and the user decides whether to apply. Phase 5.5 batch reconciliation has no second consumer for a single finding, and Phase 6's named-children carry record has no next cycle to consume it. Treat Phase 5.5 as advisory in this mode (surface-overlap detection still helps reason about multi-fix sets) and Phase 6 as a session note. Phase 0's input redaction contract applies in both modes.

## Workflow

The workflow runs **per selected finding** for Phases 0–5, **once per cycle** for Phase 5.5 (batch), and **per applied finding** for Phase 6.

### Phase 0 — Capture selected finding

For each selected finding from the cycle's user selection, capture as input:

- Codex `title` and `recommendation`.
- Claude's validity / scope note for this finding.
- `file` and `line_start` (`line_end` if codex provided one).
- User-selected scope category: `must-fix` or `minimal-hygiene`.
- Any relevant prior-cycle fix note (read from `<previous_fixes>` `<fix>` named children when available).
- Any relevant prior-cycle `<batch_reconciliation>` decisions that constrain this finding. **Match prior `<splits>` by fingerprint tuple `{normalized_title, file, line_start, scope_category}`, NOT by F-id**: codex reassigns `F<n>` every cycle, so a finding deferred as `F2` in cycle N can return as `F1` in cycle N+1; F-id-based matching either drops the constraint silently or misapplies it to an unrelated finding. Compute the current finding's fingerprint and check whether any prior `<split>` row's tuple matches.

**Input redaction contract (mandatory).** Before storing or echoing any captured codex `title` / `recommendation` / prior-fix note in any subsequent Phase output, this skill MUST apply the `review-scope-guard` SKILL.md §Secret Hygiene overlay to those strings itself. Do NOT rely on an upstream caller (`codex-review-cycle` or any other) to have redacted the bytes — even when upstream did apply the overlay, re-applying it at Phase 0 is idempotent (already-redacted content has no further matches), and re-application is the only way to keep standalone use safe. Standalone invocations (no `codex-review-cycle` wrapping, e.g. user runs the skill directly after a one-shot codex review) would otherwise echo raw findings into Phase 1 / 4 / 6 output, the per-finding heading, the recommendation quote, and the carry record — leaking any token / API key / credential the codex finding text happened to contain. The overlay applies to: `title`, `recommendation`, prior-cycle `summary` / `invariant` / `next_cycle_attack` bodies, and any `Claude's note` text that quotes codex output verbatim. Skipping the overlay is a contract violation.

### Phase 1 — Restate the invariant

Convert "line X is wrong" into "property P must always hold." Examples:

- Not: `drop macerator inventory in playerWillDestroy.`
- Instead: `macerator inventory must be dropped exactly once on every block removal path.`
- Not: `check protected host before send.`
- Instead: `the host authorized by the user must be the exact host used by the backend request.`

Phase 1 outputs an explicit `gate_status` enum that gates fix application in the caller. The five values are mutually exclusive:

- **`closed`** — invariant stated, sibling-path matrix covered, fix envelope closes the predicted next-cycle finding. Caller MAY apply.
- **`accepted-residual`** — invariant stated, but envelope leaves a known sibling path unfixed; the user has explicitly accepted the residual via `AskUserQuestion`. Caller MAY apply with the residual recorded in the Phase 6 note.
- **`invariant-unknown`** — invariant cannot be stated path-neutrally. Caller MUST NOT apply directly; the only path forward is the override-to-accepted-residual transition below.
- **`high-cascade-risk`** — invariant stated but archetype + matrix indicate the fix probably triggers a follow-on valid finding the envelope cannot close. Caller MUST NOT apply directly; the only path forward is the override-to-accepted-residual transition below.
- **`needs-user-decision`** — invariant stated, but the envelope choice itself requires user input (which sibling paths are in scope for this cycle). Caller MUST pause and route through `AskUserQuestion` before continuing.

**Override-to-accepted-residual transition** (the only mechanism by which `high-cascade-risk` or `invariant-unknown` becomes editable). When the user wants to proceed despite a non-editable status, the guard MUST run an `AskUserQuestion` that elicits four explicit fields **before** the status changes:

1. The recorded **residuals** (the specific sibling paths and follow-on findings the envelope leaves open).
2. The **surfaces** the user accepts as out of scope this cycle.
3. The **validation limits** acknowledging which checks were not run because the path is uncovered.
4. The **next-cycle attack** the user expects codex to surface and is willing to defer.

Only after all four fields are recorded does the status transition to `accepted-residual`. The transition then re-runs the per-finding gate AND the Phase 5.5 batch gate before any `Edit`/`Write` — the recorded residuals enter the batch's surface-overlap detection, so a residual one user accepts cannot silently combine with another finding's envelope into a worse cascade. Skipping the four-field record, or skipping the post-transition re-gate, is a contract violation that aborts the fix.

### Phase 2 — Classify cascade archetype

Classify the finding into one or more of the 7 archetypes (multi-label is expected; pick the dominant one for the matrix lookup but record all that apply). The archetypes consolidate the historical 13-pattern taxonomy (v1.0.0 release notes); each one absorbs related sub-patterns:

- **`path-coverage`** — same invariant across multiple code paths or iteration positions. Covers the named-path-vs-sibling-path failure (player vs system, direct vs bulk, create/update/delete, success/error/cancel, sync/async, initial/subsequent) AND the iteration-mutation failure (traversal / index / cache mutation while iterating, same-parent multi-match).
- **`state-persistence`** — invariants over mutator paths, durability, audit, and reload. Covers dirty marking, save/load, external mutation, chunk unload, restart AND audit-durability variants (semantic no-op, mutation-happened flag, flush before success, bulk/import).
- **`boundary-binding`** — checked state ≠ executed state, or boundary ownership confusion. Covers preview-vs-commit (TOCTOU, nondeterministic re-resolution, async interleaving) AND trust-boundary issues (caller vs callee, frontend vs backend, verified vs insecure, who owns confirmation).
- **`identity-contract`** — same entity has multiple representations and the fix updates only one. Covers canonical-identity (raw input, normalized path, alias, cache key, schema defaults) AND caller-contract (schema, public fields, returned payload, compatibility, migration).
- **`doc-cascade`** — sibling sections, examples, references, verification, changelog all describe related behavior and must update together when one changes.
- **`interaction-modality`** — user-facing input/output surfaces diverge. Covers input-modality (mouse/keyboard/shortcut/multi-cursor/paste/programmatic activation) AND ui-a11y (focus, live regions, z-index, pointer ownership, screen reader visibility).
- **`silent-violation`** — code passes a check or transformation that does not actually verify the property. Covers silent-transformation (formatter/serializer/importer/redactor that silently rewrites user data) AND verification-gate (tests, scripts, CI, assertions, executed-count, false-green).

### Phase 3 — Build the sibling-path matrix

Use only the rows whose archetype the finding matched in Phase 2. Do not enumerate the entire table every time — selectivity is the point.

| Archetype              | Required sweep                                                                                                                 |
|------------------------|--------------------------------------------------------------------------------------------------------------------------------|
| `path-coverage`        | every mutator path, player/system, direct/bulk, create/update/delete, success/error/cancel, sync/async, initial/subsequent, multiple matches in same parent, adjacent siblings, reverse-order apply, collect-then-apply, object key ordering |
| `state-persistence`    | every mutator path, external consumers, dirty hook, save/load, unload/reload, restart, semantic no-op, mutation-happened flag, bulk/import, delete/move/clear, flush before success |
| `boundary-binding`     | bind preview to execution, reject nondeterminism, re-check after await, move check to authoritative layer, where data becomes trusted, who owns confirmation, whether enforcement happens before or at the boundary |
| `identity-contract`    | raw input, normalized identity, alias, cache key, warm/cold/display path, omitted defaults, all consumers, field names, rendering paths, stored state, migration, version skew |
| `doc-cascade`          | intent, DoD, implementation steps, risks, verification, examples, changelog, cross refs                                        |
| `interaction-modality` | mouse, keyboard, shortcut variants, multi-cursor, paste, IME/programmatic activation, selection vs execution, focus trap, tab order, live region, visible stacking, pointer suppression, error path |
| `silent-violation`     | malformed input, mixed content, raw/CDATA, preserve-space, whitespace-only text, inline siblings, save vs manual action, removed/renamed/ignored test, zero executed, exact test identity, field presence vs default/null, test-only vs production |

For each row entry, decide:

- **Covered now** — the planned fix touches this path.
- **Must inspect before editing** — the path may need an edit but has not been verified yet (read the code/doc before deciding).
- **Out of scope** — the path is intentionally excluded; record the reason.

### Phase 4 — Choose a fix envelope

Output an explicit envelope. The envelope is what the caller will execute; vague envelopes are a contract violation:

- **Included surfaces** — what the fix covers now (file regions, doc sections, schema fields, tests).
- **Excluded surfaces** — what is intentionally out of scope (with a one-line reason: out-of-scope, impossible without larger redesign, separate follow-up, invalid premise).
- **Caller / doc / schema impact** — none, or named sibling docs and consumers that must change in lockstep.
- **Next-cycle risk** — one sentence predicting what codex is most likely to say next.

If the predicted next-cycle finding is valid and in-scope and the envelope does not close it, the envelope is not done. Either widen the envelope, accept-residual via the override transition (Phase 1), or set `gate_status: needs-user-decision`.

### Phase 5 — Add targeted validation

Require at least one validation item for the reported case AND one for the most likely sibling case from Phase 3. Examples:

- Inventory drop fix: player break + explosion/`/setblock` removal.
- Confirm-host fix: plain URL + interpolated/nondeterministic URL.
- Settings race fix: normal startup + concurrent settings write during startup.
- Doc split fix: anchor existence + verification rule consistency.
- Ledger schema fix: scope-guard output + caller projection.
- False-green test fix: removed-test negative control + executed-count assertion.
- Canonical identity fix: raw input lookup + warm-cache lookup + symlinked path.
- Editor input fix: single cursor + multi-cursor + escaped syntax.
- Silent formatter fix: malformed input fail-closed proof + lossless-roundtrip proof.
- Traversal mutation fix: same-parent multi-match + adjacent siblings.

When tests are too expensive, require a manual verification note with exact commands or inspection points. "Will be tested" without a target is not a validation item.

### Phase 5.5 — Batch reconciliation across selected findings

Runs **once per cycle**, after every selected finding has produced its per-finding envelope (Phases 0–5) and **before** any `Edit`/`Write`. The caller's multi-select can produce envelopes that are individually acceptable but collectively conflict, double-edit a surface, or leave a combined invariant violated.

Inputs (one per selected finding): invariant, archetype(s), sibling-path matrix, fix envelope, validation, residuals, predicted next-cycle attack, per-finding `gate_status`.

Steps:

1. **Surface-overlap detection.** Build the union of files, sections, caller contracts, doc anchors, and validation gates touched by every fix envelope. Flag pairs whose envelopes touch a common surface.
2. **Invariant compatibility check.** For each overlapping pair, verify the two invariants are jointly satisfiable on the shared surface. An apparent conflict (e.g. `field X must always be present` vs `field X must be absent in the new flow`) is recorded as batch `gate_status: needs-user-decision`.
3. **Order / split decision.** When envelopes are jointly satisfiable but interact (one fix's edit depends on another's), record an explicit application order. When they cannot be applied together without violating an envelope, split: apply one this cycle and defer the other to the next cycle as an explicit residual. Each split records **stable cross-cycle identity** (the deferred finding's full fingerprint tuple — `normalized_title`, `file`, `line_start`, `scope_category` — plus prior cycle and prior display_id), not just the per-cycle F-id. The next cycle's Phase 5.5 matches new findings against prior `<splits>` by fingerprint, so codex re-raising the same finding under a different F-id still hits the deferral constraint.
4. **Doc-cascade dedupe.** When two envelopes both update the same sibling doc section (e.g. CHANGELOG entry, README list), merge into a single combined edit so the doc is not double-rewritten or left half-updated.
5. **Combined-envelope prediction.** Predict the next-cycle finding the **combined** edit set is most likely to surface — distinct from per-finding predictions. If the combined prediction is in-scope and not closed, raise the batch `gate_status` accordingly.
6. **Output.** Emit a batch reconciliation summary with: shared surfaces, application order, splits / deferrals, combined-prediction, batch `gate_status`.
7. **Batch-level Phase 6 carry record.** Compose a `<batch_reconciliation>` element for the next cycle's `<previous_fixes>` (sibling to per-finding `<fix>` elements). Required whenever Phase 5.5 produced any cross-cycle decision: ≥2 findings entered Phase 5.5 (regardless of how many were ultimately applied — a 2-selected → 1-applied + 1-deferred cycle MUST persist the batch), OR `splits` is non-empty, OR `application_order` recorded an explicit ordering, OR `shared_surfaces` is non-empty. Omitted only when Phase 5.5 ran on a single-finding selection with no decisions to carry. Children: `<shared_surfaces>`, `<application_order>`, `<splits>`, `<combined_prediction>`, `<batch_gate_status>`. Each child body ≤40 words; passes through `review-scope-guard` SKILL.md §Secret Hygiene overlay before composition.

The caller reads the batch `gate_status` after Phase 5.5 and applies the same gating rule as the per-finding `gate_status` (only `closed` and `accepted-residual` permit edits; `needs-user-decision` triggers `AskUserQuestion`; `invariant-unknown` and `high-cascade-risk` block until split or override-to-accepted-residual transition).

When only one finding was selected this cycle, Phase 5.5 still runs but degenerates: shared-surface detection is trivially empty, the combined prediction equals the per-finding prediction, the batch `gate_status` mirrors the single per-finding `gate_status`, and `<batch_reconciliation>` is omitted from `<previous_fixes>`. This keeps the workflow shape uniform and the integration evals simpler.

### Phase 6 — Post-fix self-review

Runs **per applied finding**, AFTER the agent applies its `Edit`/`Write` set for that finding. Mandatory; missing notes are a contract violation that aborts the next cycle's preflight.

```markdown
Finding fixed: <title>
Invariant: <path-neutral property>
Surfaces checked: <included matrix cells>
Tests/verification: <commands or manual checks>
Known residuals: <explicit residuals, or none>
Likely next-review attack: <best adversarial follow-up and why it is closed or residual>
```

**Per-fix budget contract.** The Phase 6 envelope ships inside the next cycle's `<previous_fixes>` window with these caps, totaling at most **120 words per applied fix**:

| Field                | Cap      | Truncation priority (1 = drop first) |
|----------------------|----------|---------------------------------------|
| `<residuals>`        | 40 words | 4 (preserve longest — never empty)    |
| `<invariant>`        | 30 words | 3                                     |
| `<next_cycle_attack>`| 30 words | 2                                     |
| `<surfaces_checked>` | 20 words | 1 (recoverable from archetype + matrix on re-read) |

**Truncation rule**: when a single fix's note exceeds the per-fix cap, truncate lower-priority fields first (`<surfaces_checked>` → `<next_cycle_attack>` → `<invariant>` → `<residuals>` last). A truncated field renders as `…(truncated to fit Phase 6 budget)` so the next cycle's reader sees a missing-data marker rather than silently degraded context. `<residuals>` MUST NEVER truncate to empty — if even truncated residuals exceed the 40-word cap, the guard splits the finding into separate per-residual entries instead of dropping any.

The note is rendered through `review-scope-guard` SKILL.md §Secret Hygiene overlay before being folded into `<previous_fixes>` `<fix>` named child elements. The next cycle's preflight verifies the note exists for every applied finding; absence aborts that cycle.

## Output Template

The skill produces this shape **before edits** for each selected finding:

```markdown
## Cascade Guard — F<n>

Finding: <codex title verbatim>
Invariant: <path-neutral invariant>
Archetypes: <comma-separated list>
gate_status: <closed | accepted-residual | invariant-unknown | high-cascade-risk | needs-user-decision>

Sibling-path matrix:
- Covered now: <paths>
- Must inspect before editing: <paths>
- Out of scope: <paths + reason>

Fix envelope:
- Included surfaces: <list>
- Excluded surfaces: <list + reason>
- Caller/doc/schema impact: <none or list>
- Validation: <tests/checks>

Likely next-cycle finding:
- <one-sentence prediction>
- Status: <closed by envelope | accepted residual | needs user decision>
```

After every selected finding has its per-finding block, emit one batch reconciliation block per cycle:

```markdown
## Cascade Guard — Batch Reconciliation

Selected findings: F1, F2, …
Shared surfaces: <pairs and surfaces, or "none">
Application order: <F-id sequence>
Splits / deferrals: <list of {prior_display_id, fingerprint(normalized_title, file, line_start, scope_category), target_cycle}, or "none">
Doc-cascade merges: <sibling sections merged, or "none">
Combined-cycle prediction: <one sentence>
batch_gate_status: <closed | accepted-residual | invariant-unknown | high-cascade-risk | needs-user-decision>
```

After edits, emit one Phase 6 completion note **per applied finding** in the format above.

## Integration with codex-review-cycle

`codex-review-cycle` MUST invoke this skill at Phase 1 step 13.6 (per-finding pass) and step 13.7 (batch reconciliation), after user selection (step 13) and the fix-weight precheck (step 13.5), and BEFORE any `Edit`/`Write` at step 14. The integration contract:

- `codex-review-cycle` reads each per-finding receipt and applies edits only when it is editable: `gate_status ∈ {"closed", "accepted-residual"}` and, for `invocation_mode == "manual-fallback"`, both `matrix_evidence_present` and `validation_evidence_present` are true.
  The other three statuses block `Edit` / `Write`: `invariant-unknown` defers the finding; `high-cascade-risk` requires the override-to-accepted-residual transition; `needs-user-decision` triggers an `AskUserQuestion` to widen / split / accept-residual / defer before re-evaluating the gate.
  A manual fallback without Phase 3 / Phase 5 evidence is recorded as `manual_fallback_evidence_missing` and blocked before any edit.
- After per-finding envelopes, `codex-review-cycle` invokes the Phase 5.5 batch pass and reads the batch `gate_status` with the same gating rule.
- After edits land, `codex-review-cycle` captures the Phase 6 completion note for **every** applied selected finding (no "where appropriate" exception) and folds it into `<previous_fixes>` `<fix>` named children of the next cycle's `<review_context>`. Whenever Phase 5.5 produced any cross-cycle decision (per the §Phase 5.5 step 7 persistence trigger — ≥2 envelope-collected findings OR non-empty splits / order / shared_surfaces), also fold the batch `<batch_reconciliation>` element into the same `<previous_fixes>` block. Missing per-finding notes abort the next cycle's preflight; missing batch records abort whenever the persistence trigger held in the prior cycle.
- If `review-fix-cascade-guard` is not registered with the harness, `codex-review-cycle` MUST read `skills/review-fix-cascade-guard/SKILL.md` and run the workflow manually. The caller's `manual-fallback` receipt must be backed by visible Phase 3 matrix output and Phase 5 validation output from this template: at least one relevant matrix cell, plus reported-case and likely-sibling validation (or explicit manual verification notes for both). Silently skipping the guard or recording `manual-fallback` without that evidence is a contract violation.

The integration is part of the spec, not optional advice. Enforcement uses these no-script paths:

- **A1 — next-cycle preflight**: `codex-review-cycle` step 8 cycle-N>1 inspects Phase 6 notes, `<batch_reconciliation>`, per-finding receipts, and batch receipt from `cycle_history[N-1]` whenever a next cycle starts. This covers `Continue reviewing` / `Run a new-angle review` extensions.
- **A2 — terminal-cycle audit**: `codex-review-cycle` §Terminal-cycle audit (v1.7.0+) runs the cycle-N>1 preflight equivalent on `cycle_history[N]` before Phase 2 Case B renders when the user picks `End the review`. It covers the cascade-guard half for all scopes and the commit-state half for `branch` / `base-ref` scope; working-tree never produces a commit.
- **B — manual dogfood**: `references/dogfood-checklist.md` D1–D6 covers the A1 surfaces an executable I1–I6 harness would have tested.
- **C — documentation cross-reference invariant**: §References requires same-pass updates across this file, `codex-review-cycle/SKILL.md`'s §Terminal-cycle audit, and `codex-review-cycle/references/cycle-n-preflight.md`.

Without A2, a terminal-cycle contract violation could ship because no cycle N+1 preflight runs after a user-elected End. **Dogfood gap**: D1–D6 do not yet exercise A2's terminal-cycle End path. A follow-up dogfood pass should add a scenario whose negative control omits a Phase 6 note or receipt on the terminal cycle and verifies the §Audit-failure recovery branch. Until that scenario lands, A2 regressions rely on C.

**Enforcement model**. The contract is encoded in spec text Claude reads and follows. The receipt scheme produces an audit trail Claude inspects at the start of each cycle, catching drift in same-conversation runs (forgetting the guard, missing a Phase 6 field). Claude is both the writer and the checker, so a Claude that bypasses the guard can also forge a `closed` receipt — the scheme catches drift, not deliberate evasion. There is no out-of-band runtime guard.

## Failure Modes

- **Invariant cannot be stated path-neutrally** — set `gate_status: invariant-unknown`. The caller blocks the fix; the only path forward is the override-to-accepted-residual transition. Do NOT silently apply a fix labeled with risk.
- **Predicted next-cycle finding is in-scope and the envelope does not close it** — set `gate_status: needs-user-decision`. The caller pauses for an `AskUserQuestion` to widen / split / accept-residual / defer.
- **User accepts a residual via the override transition** — record the four required fields (residuals, surfaces, validation limits, next-cycle attack), then re-run the per-finding gate AND the Phase 5.5 batch gate before any `Edit`/`Write`. The recorded residuals enter Phase 5.5's surface-overlap detection so a residual cannot silently combine with another finding's envelope into a worse cascade.
- **Phase 6 note exceeds the per-fix 120-word cap** — truncate lower-priority fields first (`<surfaces_checked>` → `<next_cycle_attack>` → `<invariant>` → `<residuals>` last). `<residuals>` never truncates to empty; if it would, split the finding into separate per-residual carry entries.
- **Batch reconciliation finds two envelopes with conflicting invariants on the same surface** — set batch `gate_status: needs-user-decision`. The caller pauses to let the user pick which finding wins this cycle, with the loser deferred to the next cycle as an explicit `<splits>` entry.
- **Caller forgets to invoke the guard** — caught at the next cycle's `codex-review-cycle` step 8 cycle-N>1 preflight by the cascade-guard receipt check (`cycle_history[N-1].guard_receipts[<display_id>]` is missing for an applied F-id). The cycle aborts with a contract-violation message; the bypass cycle still completed but the next cycle catches it before composing review payload. Dogfood D1 walks through this scenario manually.
- **Caller is missing the guard skill registration** — the caller MUST read `skills/review-fix-cascade-guard/SKILL.md` and run the workflow manually, recording `guard_receipts[<display_id>].invocation_mode == "manual-fallback"` plus the matrix / validation evidence flags. The receipt-presence preflight check still fires. Manual-fallback receipts pass only when the evidence flags are true; silent skips do not. Dogfood D2 walks through this scenario manually.
- **Manual fallback is only nominal** — if the caller records `invocation_mode == "manual-fallback"` without a real Phase 3 sibling-path matrix and Phase 5 targeted validation evidence, treat it as a guard bypass. A valid manual-fallback record must include at least one relevant matrix cell marked `Covered now`, `Must inspect before editing`, or `Out of scope`, plus at least one validation item for the reported case and one for the most likely sibling case (or an explicit manual verification note for each when tests are too expensive). A bare `gate_status: closed` with no matrix and no validation is not a closed gate.

## Key Design Constraint

The guard makes the smallest fix that satisfies the invariant across the relevant sibling paths. If the complete invariant requires a larger scope, the guard stops, names that scope boundary, and carries an explicit residual instead of silently shipping a partial fix that will become the next cycle's valid finding. Aggressive scope expansion is itself a cascade pattern — it creates secondary edits the user did not select, sibling-doc churn, and validation gaps. The guard's bias is toward residual + deferral, not toward refactor.

## References

- `skills/codex-review-cycle/SKILL.md` — caller spec; integration is documented in `codex-review-cycle` Phase 1 step 13.6 (per-finding guard pass + invocation receipt), step 13.7 (Phase 5.5 batch + batch receipt), step 14 (gated `Edit`/`Write` + Phase 6 note capture + split-deferred F-id skip), step 15 (cycle history persistence including `phase_6_note` / `batch_envelope` / `guard_receipts` / `batch_receipt`), step 15a (cascade-guard footer summary line, user-visible audit), step 8 cycle-N>1 preflight split into commit-state preflight (branch / base-ref only) and cascade-guard preflight (all scopes including working-tree), and §Failure Modes.
- `skills/codex-review-cycle/references/review-context.md` — `<previous_fixes>` `<fix>` named-child schema (`<invariant>`, `<surfaces_checked>`, `<residuals>`, `<next_cycle_attack>`) and the `<batch_reconciliation>` sibling element schema this guard fills.
- `skills/review-scope-guard/SKILL.md` §Secret Hygiene — overlay applied to every Phase 6 child body and `<batch_reconciliation>` child body before composition.
- `references/dogfood-checklist.md` — manual D1–D6 scenarios that exercise the integration contract end to end. Run after a contract-touching change to either skill.
- `evals/review-fix-cascade-guard/evals.json` — 11 standalone external eval prompts covering the per-finding workflow on representative cascade scenarios.

### Documentation cross-reference invariant

Whenever this skill, `codex-review-cycle/SKILL.md` step 13.6 / 13.7 / 14 / 15 / step 8 preflight, or `codex-review-cycle/references/review-context.md` `<previous_fixes>` `<fix>` named children + `<batch_reconciliation>` schema is changed, **all three** files must be updated in the same edit pass. The contract is encoded across the three documents; updating one without the others creates a sibling-doc cascade (the very pattern the guard exists to prevent). The dogfood checklist's D1, D4, D5 scenarios exist to catch regressions of this invariant; re-run them after any cross-cutting edit.
