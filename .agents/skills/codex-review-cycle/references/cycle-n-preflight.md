# Cycle-N>1 Preflight

Runs at the top of `SKILL.md` Phase 1 step 8 before invoking codex on any cycle with `N > 1` — cycle 2 (the default final cycle) and any user-elected extension cycle the §Final-cycle Assessment produced. Verifies that the state between cycles matches what step 14 / 15 / 15a recorded in `cycle_history[N-1]`; mismatches indicate either a user-side state divergence or a cascade-guard contract violation (specific failure modes are listed per bullet below).

The preflight is split into two halves by scope dependency:

- **Commit-state preflight** — `branch` / `base-ref` only. Queries git history.
- **Cascade-guard preflight** — all scopes including `working-tree`. Reads in-memory `cycle_history` state.

On any failure, do NOT proceed. Print a compact explanation naming the specific check that failed and re-issue the step 14 manual-commit instruction (or the V=0 restart message). Wait for the user to correct the state and reply `continue`.

## `expected_commit` derivation

Both halves use `expected_commit = cycle_history[N-1].applied_fixes.length > 0` — a commit is only required when edits actually landed. Three legitimate no-edit cases set `expected_commit = false`:

- V=0 no-fix retries (marked by `no_fix_cycle: true`).
- All-selected-but-all-guard-blocked cycles (every selected finding's per-finding `gate_status` was non-editable).
- All-selected-but-all-split-deferred cycles (every selected finding's F-id appeared in `batch_envelope.splits[]`).

Without applied_fixes-based gating, the latter two cases would deadlock cycle N+1 with a false "user never committed" failure even though there was nothing to commit.

## Commit-state preflight (`branch` / `base-ref` only)

Single-pass check, four bullets:

- **HEAD movement**: compare `git rev-parse HEAD` against `cycle_history[N-1].pre_pause_head`.
  - `expected_commit == true`: HEAD MUST have advanced. If equal, the user never committed — re-issue the step 14 manual-commit instruction.
  - `expected_commit == false` (V=0 retry): HEAD MUST equal the stored head. If HEAD moved, the user pulled or committed unrelated work during the override pause; halt with `⚠️ HEAD changed during the V=0 override pause. Retry cycle would review an expanded target. Restart the skill or revert the changes.`
- **Working-tree cleanliness**:
  - `expected_commit == true`: `git status --porcelain -- <cycle N-1's touched_files>` MUST be empty (path-restricted to the fix set; staged/unstaged remnants of applied fixes block the cycle). Untracked files unrelated to the review_target are exempt. The `--` separator MUST be present (see SKILL.md §Failure Modes "Shell argument escaping for codex invocation").
  - `expected_commit == false` (V=0 retry, no `touched_files` exists): `git status --porcelain` with **no path restriction** MUST be empty, excepting untracked files unrelated to the review_target. Strictly wider than the `expected_commit == true` check because no commit was made — any change to tracked files during the override pause would expand the review target. On failure, halt with `⚠️ Working tree changed during the V=0 override pause. Retry cycle would review an expanded target. Restart the skill or revert the changes.`
- **Commit-delta coverage** (only when `expected_commit == true`): `git diff --name-only <pre_pause_head>..HEAD -- <touched files>` must be non-empty AND must cover every file in cycle N-1's `applied_fixes[*].touched_files[]` list. Any touched file missing from this delta means the user's commit did not include that file. A legitimate fix that reverts a file back to base is still a valid commit delta even though the file disappears from `<base_sha>...HEAD` — this variant catches that case because it queries the commit-delta range, not the branch-total range. Skipped entirely for V=0 retries.
- **Cycle-commit ownership (warn-and-confirm)** (only when `expected_commit == true`): compare the full commit-delta path list against cycle N-1's `touched_files`. Run `git diff --name-only <pre_pause_head>..HEAD` (no path restriction) and let `committed_paths` be that output. Paths in `committed_paths` not in cycle N-1's `touched_files[]` are *unrelated* — typically lint autofixes, typo repairs, or adjacent cleanups the user bundled into the cycle commit. Surface them via a single `AskUserQuestion`:
  - `question`: "Cycle N-1 commit includes <K> path(s) that Claude did not touch: <full path list>. These will be preserved by the terminal soft-reset and ship in the final squash. Keep them as part of this review's squash, or abort for amend-drop?"
  - options:
    - `Keep (continue to cycle N)` — record the extras in `cycle_history[N-1].unrelated_commit_paths[]` for the step-20 Part B audit. Proceed to cycle N.
    - `Abort to amend` — print `Amend your cycle N-1 commit to drop the unrelated paths, then reply continue.` and pause the skill like the manual-commit gate in step 14.

  Skipped entirely for V=0 retries.

## Cascade-guard preflight (all scopes)

Reads in-memory `cycle_history` state populated at step 13.6 / 13.7 / 14 / 15. Working-tree cycles have no commits to inspect but still populate `applied_fixes[]` / `phase_6_note` / `guard_receipts` / `batch_envelope` / `batch_receipt` in the prior cycle's `cycle_history` entry, so the same drift checks apply. Run after the commit-state preflight (when applicable) and before focus-text composition.

- **Cascade-guard Phase 6 note presence** (runs whenever `cycle_history[N-1].applied_fixes[]` is non-empty, regardless of scope or `expected_commit`). For every entry in `cycle_history[N-1].applied_fixes[]`, verify `phase_6_note` is populated and contains all four required fields (`invariant`, `surfaces_checked`, `residuals`, `next_cycle_attack`); empty values are allowed only for `surfaces_checked` (the lowest truncation-priority field), and `residuals` is never permitted to be empty per `review-fix-cascade-guard` SKILL.md §Phase 6. On failure, halt with `⚠️ Phase 6 note missing for cycle N-1 applied fix <display_id>. Cascade context cannot be carried; restart the skill or amend cycle N-1's commit to include the missing note.` Without the note, the next cycle's `<previous_fixes>` `<fix>` named children compose to empty, dropping the cascade context the guard exists to carry.
- **`<batch_reconciliation>` presence when Phase 5.5 had cross-cycle decisions to carry**. Trigger matches the step 13.7 persistence rule: when N-1 envelope-collected ≥2 findings into Phase 5.5, OR recorded any non-empty `splits` / `application_order` / `shared_surfaces`, verify `cycle_history[N-1].batch_envelope` is non-null and contains all five required fields (`shared_surfaces`, `application_order`, `splits`, `combined_prediction`, `batch_gate_status`). On failure, halt with `⚠️ <batch_reconciliation> record missing for cycle N-1 (Phase 5.5 produced cross-cycle decisions that were not carried). The next cycle's Phase 5.5 cannot detect order/split violations without the prior batch context; restart the skill.` Skipped only when N-1 ran Phase 5.5 on a single-finding selection with no decisions to carry.
- **Cascade-guard invocation receipts** (step 13.6 / 13.7 receipts). This mirrors the editability predicate step 14 used before applying edits, so the next-cycle preflight catches persisted-state drift or any bypass that reached `applied_fixes[]`. A per-finding receipt is editable only when `gate_status ∈ {"closed", "accepted-residual"}` and, for `manual-fallback`, both evidence flags are true. Run this three-part check on every entry in `cycle_history[N-1].applied_fixes[]`:
  1. **Receipt presence** — `cycle_history[N-1].guard_receipts[<display_id>]` exists with all six fields (`gate_status`, `archetypes`, `invocation_mode`, `matrix_evidence_present`, `validation_evidence_present`, `ts`). On failure, halt with `⚠️ Cascade-guard receipt missing for cycle N-1 applied fix <display_id>. Fix was applied without a guard pass; this is a contract violation. Restart the skill or revert the fix.`
  2. **Receipt gate_status editability** — `guard_receipts[<display_id>].gate_status ∈ {"closed", "accepted-residual"}`. A receipt that exists but records a non-editable status (`invariant-unknown`, `high-cascade-risk`, `needs-user-decision`) means the fix was applied despite the gate blocking it — the bypass class the receipt scheme catches. On failure, halt with `⚠️ Cascade-guard receipt for cycle N-1 applied fix <display_id> recorded gate_status=<value>; only "closed" or "accepted-residual" permit edits per step 14. Fix was applied past a blocking gate; this is a contract violation. Restart the skill or revert the fix.`
  3. **Manual-fallback evidence** — when `guard_receipts[<display_id>].invocation_mode == "manual-fallback"`, both evidence flags MUST be true. `matrix_evidence_present == false` means Phase 3's sibling-path matrix was only nominal; `validation_evidence_present == false` means Phase 5 did not prove the reported case plus likely sibling case. On failure, halt with `⚠️ Manual cascade-guard fallback for cycle N-1 applied fix <display_id> lacks Phase 3/Phase 5 evidence. A manual closed receipt without matrix and validation evidence is a guard bypass. Restart the skill or revert the fix.`

  Parallel two-part check for the batch receipt when `cycle_history[N-1].batch_envelope != null` (i.e. when Phase 5.5 produced cross-cycle decisions, regardless of applied count — see step 13.7):
  1. **Batch receipt presence** — `cycle_history[N-1].batch_receipt` is non-null with all four fields. On failure, halt with `⚠️ Cascade-guard batch receipt missing for cycle N-1 (Phase 5.5 produced a batch_envelope). Restart the skill.`
  2. **Batch receipt gate_status editability (only when edits landed)** — when `cycle_history[N-1].applied_fixes.length > 0`, `batch_receipt.batch_gate_status` MUST be `"closed"` or `"accepted-residual"`. A non-editable batch status combined with non-empty applied fixes means the batch correctly blocked but Claude applied edits anyway — bypass detected. On failure, halt with `⚠️ Cascade-guard batch receipt for cycle N-1 recorded batch_gate_status=<value> with <K> edits applied; only "closed" or "accepted-residual" permit edits per step 14. Batch fix set was applied past a blocking gate; this is a contract violation. Restart the skill or revert the fixes.` When `applied_fixes.length == 0`, a non-editable batch status is the legitimate "all blocked / all deferred" outcome (no edits landed, deferrals carry forward via `<splits>`); accept the receipt without aborting. The same conditional applies to the per-finding receipt editability check above — but per-finding entries that DID enter `applied_fixes[]` MUST individually have editable status, since their presence in the bucket is by definition an applied edit.

These receipts catch guard-bypass regressions at the next cycle's preflight (not a runtime guard); a bypass cycle completes, but the next cycle catches it before composing review payload.
