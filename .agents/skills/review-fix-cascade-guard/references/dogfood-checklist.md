# Dogfood Checklist

Manual scenarios that exercise the `review-fix-cascade-guard` ↔ `codex-review-cycle` integration contract end to end. Run this checklist once after a contract-touching change to either skill (e.g. when extending the `gate_status` enum, when changing the Phase 6 budget, when reshaping `<previous_fixes>` `<batch_reconciliation>`, or when modifying the receipt schema in `cycle_history`).

This checklist replaces an executable integration harness. The trade-off is explicit: there is no CI gate, only manual walk-through. The compensating checks live in `codex-review-cycle` SKILL.md step 8 (cycle-N>1 preflight) — Phase 6 note presence, `<batch_reconciliation>` presence, and cascade-guard invocation receipts surface contract violations one cycle later. These are Claude-executed spec-level checks, not harness-enforced runtime guards: they detect drift when Claude runs the preflight honestly and do not prevent a bypass that also forges the audit trail.

## How to run

For each scenario below, set up the working tree as described, invoke `codex-review-cycle` (working-tree scope, adversarial-review variant), then walk through the cycles observing the listed assertions. Record the outcome inline; a failure means the contract regressed and the change is not ready to ship.

Each scenario is small (one or two findings) so a single dogfood pass takes minutes. The six scenarios cover the same contract surfaces an executable harness would have tested (I1–I6 in the historical plan), but rely on observing the running skill rather than asserting via JSON.

## D1 — Guard-before-edit ordering

**Setup**: in a scratch git repo, edit one file with a small bug codex will catch (e.g. an inverted `if` condition, a missing null check, a `let` that should be `const`).

**Run**: `codex-review-cycle` working-tree scope, adversarial-review variant, single cycle.

**Observe**:

- The cycle 1 summary lists at least one `valid` + `must-fix` finding.
- After your selection, Claude prints a `Cascade Guard — F<n>` block (per-finding envelope) **before** any `Edit`/`Write` call.
- If multiple findings were selected, Claude prints a `Cascade Guard — Batch Reconciliation` block before the first `Edit`/`Write`.
- The cycle's final state shows `cycle_history[1].guard_receipts[F<n>]` populated with `gate_status`, `archetypes`, `invocation_mode`, `ts` for every applied or gate-blocked finding.

**Failure signal**: an `Edit`/`Write` appears in the transcript before the per-finding cascade-guard block, OR `guard_receipts` is missing entries.

## D2 — Unregistered-skill fallback

**Setup**: temporarily rename `skills/review-fix-cascade-guard/` to `skills/review-fix-cascade-guard.disabled/` (or any name the harness will not match) so `Skill(review-fix-cascade-guard)` lookup fails. Restore the original name when finished.

**Run**: same as D1.

**Observe**:

- Claude detects the skill is unregistered and prints a notice explaining it will read `skills/review-fix-cascade-guard.disabled/SKILL.md` (or the renamed path) and run the workflow manually.
- The per-finding `Cascade Guard — F<n>` block still appears with the same shape.
- `guard_receipts[F<n>].invocation_mode == "manual-fallback"` shows in the cycle summary footer (step 15a cascade-guard line), and the receipt records `matrix_evidence_present == true` plus `validation_evidence_present == true`.
- The manual block contains at least one concrete Phase 3 sibling-path matrix cell and Phase 5 validation for both the reported case and likely sibling case (or explicit manual verification notes for both).
- No `Edit`/`Write` happens before the manual-fallback block.
- Negative-control variant: omit the Phase 3 matrix or Phase 5 validation notes in the manual fallback transcript. The cycle must record `manual_fallback_evidence_missing`, place the finding in `user_declined[]`, and perform no `Edit`/`Write` for that finding even if the manual receipt says `gate_status: closed`.

**Failure signal**: Claude silently skips the guard, `Edit` happens without a manual-fallback notice, or an evidence-free `manual-fallback` / `closed` receipt permits an edit instead of being blocked as `manual_fallback_evidence_missing`.

**Cleanup**: rename the directory back to `skills/review-fix-cascade-guard/`.

## D3 — Pause-on-open-envelope

**Setup**: write a file that contains a *deliberately ambiguous* invariant — e.g. a function that writes audit logs only on the success path, where codex would surface "audit fires only on success" as a finding. The fix could be widened to error/cancel/no-op paths (sibling-path matrix), or scoped narrowly. Choose to scope narrowly so the guard surfaces `gate_status: needs-user-decision` (or `high-cascade-risk` if the matrix predicts a follow-on finding).

**Run**: same as D1; select the audit finding.

**Observe**:

- The per-finding cascade-guard block shows `gate_status: needs-user-decision` (or `high-cascade-risk` / `invariant-unknown`).
- Claude pauses and issues an `AskUserQuestion` (widen / split / accept-residual / defer).
- If you choose `accept-residual`, the guard re-runs the override-to-accepted-residual transition (4 fields recorded), then the per-finding gate AND batch gate re-run.
- No `Edit`/`Write` happens until the gate flips to `closed` or `accepted-residual`.

**Failure signal**: Claude applies the fix despite a non-editable `gate_status`, OR the override transition skips the 4-field recording.

## D4 — Phase 6 note carry-forward

**Setup**: same as D1, but plan to run two cycles. Pick a fix that codex's cycle 2 review would find a sibling-path follow-on for (e.g. fix the `if` inversion only, leave the matching `else` branch intact).

**Run**: cycle 1 applies the fix, cycle 2 starts.

**Observe**:

- Cycle 2's `<review_context>` `<previous_fixes>` block contains a `<fix>` element with the four named children (`<invariant>`, `<surfaces_checked>`, `<residuals>`, `<next_cycle_attack>`) populated from cycle 1's Phase 6 note.
- The cycle-2 summary footer shows the per-finding receipt summary (`N findings passed cascade-guard`) confirming guard ran for cycle 1's applied fix.

**Negative-control variant** (no in-memory editor exists for `cycle_history`, so simulate the regression before cycle 1 starts): edit `skills/review-fix-cascade-guard/SKILL.md` Phase 6 to instruct the writer to skip one field (e.g. delete the `<residuals>` requirement). Run cycle 1 with the patched skill, then cycle 2. Cycle 2's preflight should abort with `⚠️ Phase 6 note missing for cycle 1 applied fix F<n>.` Restore the SKILL.md after the test.

**Failure signal**: cycle 2 proceeds with empty `<fix>` named children, OR the negative-control variant's preflight does not abort on the missing field.

## D5 — Multi-select batch reconciliation (two-cycle)

**Setup**: write a file with at least two findings codex will catch whose envelopes share a surface (e.g. two functions in the same file that both call a helper with the same buggy argument; the helper is the shared surface).

**Run**: cycle 1 selects both findings, cycle 2 starts.

**Observe in cycle 1**:

- After per-finding cascade-guard blocks, Claude prints a `Cascade Guard — Batch Reconciliation` block listing the shared helper as `Shared surfaces` and naming an `Application order` or recording a `Splits` deferral.
- The batch `gate_status` is `closed` (or `accepted-residual` after an override).
- `cycle_history[1].batch_envelope` and `cycle_history[1].batch_receipt` are both populated.

**Observe in cycle 2**:

- Cycle 2's `<previous_fixes>` contains a `<batch_reconciliation>` sibling element with all five children populated.
- If cycle 1 recorded a `<splits>` deferral, cycle 2's review surfaces the deferred finding again (codex re-raises it).
- Cycle 2's Phase 5.5 reads the prior `<application_order>` / `<splits>` and rejects any new fix whose envelope would violate them (try selecting a contrived new finding that touches the deferred surface; the batch should pause for `needs-user-decision`).

**Failure signal**: cycle 2's `<previous_fixes>` is missing `<batch_reconciliation>`, OR the new cycle silently violates the prior batch decision.

## D6 — Phase 6 budget and truncation priority

**Setup**: write a file with up to 6 codex-detectable findings (a tightly-bug-seeded source file of ~100 lines; aim for variety so the guard's per-finding envelope is genuinely substantive — long invariants, multi-path matrices, real residuals).

**Run**: cycle 1 selects all 6 findings.

**Observe**:

- Each `<fix>` element in cycle 2's `<previous_fixes>` stays within the per-fix 120-word cap across the four cascade-guard children.
- When a single fix's note exceeds 120 words, the writer truncates `<surfaces_checked>` first, then `<next_cycle_attack>`, then `<invariant>`, leaving `<residuals>` intact. Truncated fields render as `…(truncated to fit Phase 6 budget)`.
- `<residuals>` is never empty for any applied fix that had real residuals; if even truncated residuals exceed 40 words, the writer splits the finding into separate per-residual `<fix>` entries.
- The total `<previous_fixes>` content stays within the extended per-cycle window (~720 words for the cascade-guard children plus the legacy `<title>` + `<summary>` budget).

**Failure signal**: a `<residuals>` field is empty when residuals existed, OR `<surfaces_checked>` is preserved while higher-priority fields were truncated, OR the per-cycle window overflows visibly (codex rejects the focus text or truncates mid-element).

**CDATA terminator subcheck**: codex's title content is not directly controllable, so this check is a read-only inspection rather than a synthetic-input test. Whenever a real cycle's `<previous_fixes>` `<fix>` body or `<split>` child happens to contain a CDATA-terminating sequence in any of its CDATA-wrapped fields, inspect the rendered XML: every embedded `]]>` MUST appear as `]]]]><![CDATA[>` (the splitter replacement per `references/review-context.md`). The first `]]` closes one section and `<![CDATA[` reopens the next so concatenating consecutive CDATA bodies recovers the original byte stream. If you want to force-test the splitter offline, hand-craft a synthetic `<previous_fixes>` block (e.g. paste a sample into a test harness or scratchpad) containing `]]>` in a body and verify the writer's output applies the split. Skipping the splitter corrupts the surrounding `<review_context>` block and codex either rejects the focus text or parses past the split into uncontrolled content — a contract violation that opens the inert-data boundary.

## When to re-run

Run the full checklist (D1–D6) after any of the following:

- A change to `review-fix-cascade-guard` SKILL.md that touches the `gate_status` enum, the Phase 5.5 workflow, the Phase 6 note shape, or the override-to-accepted-residual transition.
- A change to `codex-review-cycle` SKILL.md that touches step 13.6, 13.7, 14, 15, or step 8's cycle-N>1 preflight.
- A change to `codex-review-cycle/references/review-context.md` that reshapes `<previous_fixes>` `<fix>` named children, the `<batch_reconciliation>` sibling element, or the per-fix budget contract.

Spot-checks (D1, D4, D5) are sufficient for changes that touch only one surface (e.g. budget tweak only → D6 alone).
