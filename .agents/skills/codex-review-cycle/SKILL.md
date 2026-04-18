---
version: 1.1.0
name: codex-review-cycle
description: Run a bounded 3-cycle interactive review-and-fix workflow against a user-chosen git review target (working-tree diff, current branch vs. auto-detected base, or an explicit commit/tag/branch ref) using the codex plugin. Each cycle invokes codex `review` or `adversarial-review --json`; Claude verifies each finding against a six-item validity checklist, calls `review-scope-guard` for Definition-of-Done triage, and the user picks which findings to fix before the next cycle. Covers both code diffs and markdown planning documents. Hard cap at 3 cycles. Use ONLY when the user explicitly asks to run the codex review cycle on working-tree changes, a committed branch diff, or an explicit base ref. Do NOT trigger for single-shot review requests, auto-hardening, background reviews, plan drafting, or when the chosen target would produce an empty diff.
---

# Codex Review Cycle

## Overview

A simple, user-driven review-and-fix workflow. Every cycle runs one codex review, Claude verifies each finding's validity, presents a verbatim summary, and the user picks which findings to address. Claude then applies only the chosen fixes and loops. Three cycles is a hard cap — the loop never runs a fourth cycle without the user starting a new invocation.

The skill is deliberately simple. It does not auto-fix, does not run parallel reviewers, does not compute stall fingerprints, does not manage autonomy bands, and does not delegate to rescue subagents. Claude is the only fix applier; the user is the only arbiter of which findings matter.

## Language

All user-facing output is rendered in the user's language (the language the user has been using in the conversation, or as configured in the Claude Code system-level language setting). This section is the **authoritative translation contract** — any per-language sample reference (e.g. `references/summary-samples.ja.md`) is illustrative only and MUST NOT contradict these rules.

**Translate into the user's language:**

- Section headings and column labels (`Claude's note`, `Recommended action`, `Scope`, `Severity`, etc. column *header text*)
- Free-text fields Claude authors: `Claude's note` body, `Recommended action` values, fleet-rate warnings, stop-signal footer prose, termination messages, post-cycle review assessment
- `AskUserQuestion` `question`, `header`, and option `label` / `description` fields

**Keep verbatim (do NOT translate), regardless of user language:**

- Codex `title` field (surfaced in the `Title (codex verbatim)` column)
- Codex `recommendation` field (quoted below the table per §Summary Output Template)
- Severity values (`high` / `medium` / `low`) — codex output
- Validity outcome keywords (`valid` / `partially-valid` / `invalid`)
- Scope category names (`must-fix` / `minimal-hygiene` / `reject-out-of-scope` / `reject-noise`)
- Stop-signal `Status` keywords (`ACTIVE` / `ADVISORY` / `WARNING` / `silent`)
- Technical identifiers: file paths, git refs (SHAs, branch names), `fingerprint`, `cluster_id`, field names like `applied_fixes`, `not_evaluated_signal_names`
- Cycle indices (`cycle N`, `N/3`)

For a Japanese rendering example that applies these rules, see `references/summary-samples.ja.md`. For German, Korean, or other languages, apply the same rules directly — the Japanese sample is an illustration, not a template to translate.

## When to Use

Use this skill ONLY when:

- The user explicitly asks to run the codex review cycle on one of: the current working-tree diff, the current branch vs. its base branch, or an explicit commit/tag/branch ref, and
- The current working directory is a git repository, and
- The chosen review target produces a non-empty diff (working tree has uncommitted changes, or HEAD is ahead of the chosen base ref).

Do NOT use this skill when:

- The user wants a single codex review pass — use the codex plugin directly.
- The resolved review target produces an empty diff — stop and tell the user.
- The user is drafting a plan from scratch — use `vibe-planning-guard` instead.
- A review is running as a background or automatic check.

## Review Target Modes

The skill supports three review targets, chosen once at Phase 0 and fixed for all three cycles:

- **`working-tree`** — uncommitted changes (tracked-modified + staged + untracked). Codex is invoked with `--scope working-tree`. Claude-side diff commands use `git diff HEAD --name-only` plus `git ls-files --others --exclude-standard` for untracked files.
- **`branch`** — HEAD vs. the auto-detected default branch (tries local `main`/`master`/`trunk` first, then `origin/*`). Codex is invoked with `--base <base_sha>` (frozen SHA resolved from the detected ref at Phase 0). Claude-side diff commands use `git diff --name-only <base_sha>...HEAD` (triple-dot: merge-base semantics).
- **`base-ref`** — HEAD vs. an explicit ref the user supplies (any commit SHA, tag, or branch name). Codex is invoked with `--base <base_sha>` (frozen SHA resolved from the user-supplied ref at Phase 0). Claude-side diff commands use `git diff --name-only <base_sha>...HEAD`.

The three modes share the same workflow — only the Phase 0 target-resolution step, the codex CLI flags, and the diff command Claude uses for validity checks differ.

## Target Kinds

The skill auto-detects `code` vs `plan` from the diff file extensions. See `references/focus-text.md` for the detection rules. Mixed targets (any code file present) are treated as `code`; item 6 of `references/validity-checklist.md` filters out detailed-design findings on markdown files inside a code cycle.

## Review Variant Selection

At Phase 0, ask the user once which codex review variant to use for all three cycles:

- **`review`** — codex's native review command. Output is free-form text. Claude manually structures each finding section into `title` / `recommendation` / `body` before running the validity check.
- **`adversarial-review`** — codex's adversarial review with `--json`. Output is structured `findings[]`. Each element has `severity`, `file`, `line_start`, `title`, `recommendation`, `body`. Adversarial cycles also carry a `<review_context>` block (see §Review Context Format) so codex keeps the same angle across cycles.

The choice is fixed for the whole loop. If the user wants to switch variants, they must restart the skill.

**Recommendation**: use `adversarial-review` unless there is a specific reason not to. The `review` variant is retained for environments where structured JSON output is unavailable or for users who specifically want free-form codex output, but it operates in a **minimum-functionality mode**: no `<review_context>` carry across cycles, no proposal-mode DoD (interview only), no V=0 cycle-N+1 override, no rejected-findings forwarding. Expect to get a single-shot review that Claude structures manually, with no adaptation between cycles. For multi-cycle review-and-fix workflows, adversarial-review is strictly the better path.

## Workflow

### Phase 0 — Preflight (runs once)

1. **Verify git repository.**
   - `Bash`: `git rev-parse --is-inside-work-tree` — stop if not inside a git repo.
2. **Resolve the review target.** Ask the user once, via `AskUserQuestion`, which review scope this cycle should cover. Offer three options:
   - **`working-tree`** — review the uncommitted diff (tracked-modified + staged + untracked).
   - **`branch`** — review HEAD vs. the auto-detected default branch.
   - **`base-ref`** — review HEAD vs. an explicit ref the user provides.

   After the scope choice:
   - `working-tree`: no additional input needed.
   - `branch`: auto-detect the default branch by trying `main`, `master`, `trunk` as local refs via `git show-ref --verify --quiet refs/heads/<name>`, then falling back to `origin/<name>`. If none resolve, stop with `Could not auto-detect a base branch. Re-run with scope = base-ref and supply a ref explicitly.`
   - `base-ref`: ask a follow-up free-form `AskUserQuestion` for the ref string. Validate it with `git rev-parse --verify <ref>` — if the command fails, stop with `Base ref '<ref>' not found in this repository.`

   Store the result as `review_target`. **Fully construct the object in Phase 0 so proposal DoD mode in step 7 has the data it needs**:
   - `scope` — one of `working-tree`, `branch`, `base-ref`.
   - `base_ref` — `null` for `working-tree`; the resolved ref **string** for `branch` and `base-ref` (kept as display metadata only).
   - `base_sha` — `null` for `working-tree`; for `branch` / `base-ref`, the **immutable commit SHA** resolved from `base_ref` at Phase 0 via `git rev-parse <base_ref>`. All subsequent commands across all 3 cycles (codex `--base`, diff commands, commit-range enumeration, validity-check scope diff, Part B ownership audit, soft-reset anchor) use `base_sha`, never `base_ref`, so a mutable ref (e.g. `main`, `origin/main`) advancing mid-run cannot drift the review target. If `base_ref != base_sha` at any later check (user manually updated the ref), print a one-line warning `Base ref '<base_ref>' moved from <base_sha> during the run; continuing against the frozen SHA.` and proceed.
   - `diff_command` — the exact `git diff --name-only …` command Claude will reuse for target-kind detection and validity checks:
     - `working-tree` → `git diff HEAD --name-only` (paired with `git ls-files --others --exclude-standard` for untracked files)
     - `branch` / `base-ref` → `git diff --name-only <base_sha>...HEAD` (triple-dot: merge-base semantics; uses the **frozen SHA**, not the mutable `base_ref`, so target-kind detection and validity checks cannot drift if the named ref advances mid-run)
   - `diff_files` — the executed output of `diff_command`. **For `working-tree` scope, this MUST be the union of `git diff HEAD --name-only` and `git ls-files --others --exclude-standard` (tracked-modified + staged + untracked)**; omitting untracked files would undercount the actual review surface. For `branch` / `base-ref` it is just the `diff_command` output.
   - `diff_numstat` — for `branch` / `base-ref`: `git diff --numstat <base_sha>...HEAD`. For `working-tree`: `git diff --numstat HEAD` **PLUS** a synthesized per-untracked-file line count (e.g. `wc -l` on each untracked file, emitted in the same `<added>\t<deleted>\t<path>` shape as numstat so the total LOC calculation is uniform). Omitting untracked line counts — as an earlier draft did — would let an untracked-only working-tree diff (100% new files) report 0 numstat LOC and silently qualify for proposal-mode DoD with no commit messages or patch to ground intent. Used to size the diff for the proposal-mode threshold (≤ ~100 changed LOC).
   - `commit_range` — `null` for `working-tree`; `<base_sha>..HEAD` (double-dot, using the **frozen SHA** for commit-delta enumeration) for branch / base-ref. NOTE: diff uses triple-dot (merge-base), commit enumeration uses double-dot (exact commits on HEAD that are not on base). Using `base_sha` (not `base_ref`) keeps enumeration stable against mid-run ref movement.
   - `commit_messages[]` — `[]` for `working-tree`; `git log --format='%s%n%b' <commit_range>` splits for branch / base-ref, trimmed per commit. Derives from the frozen-SHA `commit_range` above. Proposal-mode DoD drafting reads these to ground item 1 (intent) and item 4 (out-of-scope) in what the commits actually claim.
   - `diff_patch_excerpts` — bounded content-bearing evidence: a handful of representative files shown mostly in full (small untracked files, key tracked hunks), trimmed with `[truncated — <M> more lines]` when needed. Keep the total roughly on the order of a few KB so the proposal-mode prompt stays manageable. The goal is "enough for Claude to infer intent and out-of-scope boundaries", not byte-exact compliance.
     - **`working-tree`**: always synthesize.
     - **`branch` / `base-ref`**: omit only when the proposal-mode evidence gate is already satisfied by commit messages (≥20-char subject + non-empty body in at least one commit in scope). If the evidence gate fails on messages alone — squashed / templated / vague commits — synthesize excerpts **sourced exclusively from the target commit range** (`git diff <base_sha>...HEAD` output), never from local working-tree state or untracked files, using the same bounded-budget shape as `working-tree`. If the range cannot yield a usable excerpt (binary-only, no textual diff), fall back to `interview` mode. This preserves the existing invariant that DoD drafting for branch/base-ref never anchors on a short squash-commit title AND never leaks out-of-range evidence into the proposal.

   **Proposal-mode evidence gate**: even when `diff_numstat` totals ≤ 100 LOC, proposal mode requires content-bearing evidence.
   - For `working-tree` scope: if `commit_messages[]` is empty AND `diff_patch_excerpts` has no non-blank content (e.g. all untracked files are empty or binary, or all tracked-modified hunks collapsed to no patch), fall back to `interview` mode — filenames and line counts alone cannot draft six DoD items with enough fidelity.
   - For `branch` / `base-ref` scope: commit messages alone are NOT sufficient evidence. Squashed, templated, or vague messages like `"fix review comments"`, `"wip"`, `"update tests"` can pass the LOC threshold while giving proposal mode no usable intent or out-of-scope signal. Require that `commit_messages[]` contain at least one commit with a subject of **≥20 characters AND a non-empty body**, OR fall back to populating `diff_patch_excerpts` for branch/base-ref (same budget-based heuristic as working-tree) and passing it forward. If neither evidence path is available — all commit messages are short/empty and no patch excerpts are synthesized — fall back to `interview` mode. The risk this gate blocks is a DoD drafted from the title of a squash commit, which then anchors `reject-out-of-scope` decisions for the whole run.

   Every cycle reuses the same `review_target` so the diff scope stays stable even after fixes are applied.
3. **Verify the target has a non-empty diff.**
   - `working-tree`: `git status --porcelain` must be non-empty. If empty, stop with `No working-tree diff to review. The codex-review-cycle skill requires uncommitted changes when scope is working-tree.`
   - `branch` / `base-ref`: `git diff --name-only <base_sha>...HEAD` (use the frozen SHA from step 2, not the mutable `base_ref`) must be non-empty. If empty, stop with `No committed changes between <base_ref> (<base_sha>) and HEAD. The codex-review-cycle skill requires a non-empty diff for branch/base-ref scopes.`
4. **Ensure codex is ready.** Invoke `Skill(codex:setup)` once to confirm the codex CLI is configured. Stop if setup reports a blocking failure.
5. **Detect target kind.**
   - Run `review_target.diff_command`. For `working-tree`, also run `git ls-files --others --exclude-standard` and union the untracked list with the diff output.
   - Apply the extension rules in `references/focus-text.md`.
   - Record `target_kind` as either `code` or `plan`.
6. **Ask for review variant** (once, via `AskUserQuestion`). Two options: `review` and `adversarial-review`. Store the choice as `variant`.
7. **Pre-collect DoD (adversarial only) and initialize cycle state.** Set `rejected_ledger = []`, `cycle_history = []`, `dod = null`.
   - If `variant == adversarial-review`, collect the six-item Definition of Done now by invoking the four-mode collection flow in `skills/review-scope-guard/references/dod-template.md` §Collection Modes, passing the fully-constructed `review_target` from Phase 0 step 2 (including `diff_files`, `diff_numstat`, `commit_messages[]`) as the proposal-mode input contract. Default to `interview`; use `proposal` when `review_target.diff_numstat` totals ≤ ~100 LOC AND commit-messages or patch excerpts provide content-bearing evidence; use `quick` when the diff is ≤ ~30 LOC AND the user explicitly said "quick DoD" / "minimal DoD" / similar; use `free-text` when the user has already pasted a DoD block in the conversation. If `review_target` is somehow incomplete (defensive check — Phase 0 step 2 should have populated every field), force `interview` mode per the scope-guard input contract. Cache the result on `dod` so `<review_context cycle="1">` `<intent>` can be populated from DoD item 1 before step 8 runs. Pass the cached `dod` (not `null`) to `review-scope-guard` at step 10a so the scope-triage skill does not re-ask. This solves the cycle-1 dependency where `<review_context>` would otherwise need intent that had not yet been collected.
   - If `variant == review`, leave `dod = null` here. Native review does not carry `<review_context>`, so there is no early-intent dependency. Step 10a's first `review-scope-guard` invocation will collect DoD interactively at that point.

   Also record `pre_cycle_1_head = git rev-parse HEAD` — this is the anchor for the step 20 soft-reset at termination. For `working-tree` scope this value is unused.

   Subsequent cycles reuse the cached DoD and pass the running `rejected_ledger` / `cycle_history` forward.

### Phase 1 — Review Cycle (repeats up to 3 times; counter `N = 1..3`)

8. **Run the review.** Compute `codex_scope_args` from `review_target.scope`:
   - `working-tree` → `--scope working-tree`
   - `branch` → `--base <review_target.base_sha>` (frozen SHA from Phase 0; NOT `base_ref`, which is mutable)
   - `base-ref` → `--base <review_target.base_sha>`

   **Cycle-N>1 preflight** (`branch` / `base-ref` only): before invoking codex on cycle 2 or 3, verify the state between cycles is as expected. Let `expected_commit = !cycle_history[N-1].no_fix_cycle` (true for normal fix cycles, false for V=0 no-fix retries). Run the following single-pass check:

   - **HEAD movement**: compare `git rev-parse HEAD` against `cycle_history[N-1].pre_pause_head`.
     - If `expected_commit` is true: HEAD MUST have advanced. If equal, the user never committed — re-issue the step 14 manual-commit instruction.
     - If `expected_commit` is false (V=0 retry): HEAD MUST equal the stored head. If HEAD moved, the user pulled or committed unrelated work during the override pause; halt with `⚠️ HEAD changed during the V=0 override pause. Retry cycle would review an expanded target. Restart the skill or revert the changes.`
   - **Working-tree cleanliness**:
     - When `expected_commit` is true: `git status --porcelain -- <cycle N-1's touched_files>` MUST be empty (path-restricted to the fix set; staged/unstaged remnants of applied fixes block the cycle). Untracked files unrelated to the review_target are exempt.
     - When `expected_commit` is false (V=0 retry, no touched_files exists): `git status --porcelain` with **no path restriction** MUST be empty, excepting untracked files unrelated to the review_target. This is strictly wider than the expected_commit=true check because no commit was made — any change to tracked files during the override pause would expand the review target and invalidate the retry. On failure, halt with `⚠️ Working tree changed during the V=0 override pause. Retry cycle would review an expanded target. Restart the skill or revert the changes.`
   - **Commit-delta coverage** (only when `expected_commit` is true): `git diff --name-only <pre_pause_head>..HEAD -- <touched files>` must be non-empty AND must cover every file in cycle N-1's `applied_fixes[*].touched_files[]` list. Any touched file missing from this delta means the user's commit did not include that file. A legitimate fix that reverts a file back to base is still a valid commit delta even though the file disappears from `<base_sha>...HEAD` — this variant catches that case because it queries the commit-delta range, not the branch-total range. Skipped entirely for V=0 retries (no commits to audit).
   - **Cycle-commit ownership (warn-and-confirm)** (only when `expected_commit` is true): compare the full commit-delta path list against cycle N-1's `touched_files`. Run `git diff --name-only <pre_pause_head>..HEAD` (no path restriction) and let `committed_paths` be that output. Paths in `committed_paths` that are NOT in cycle N-1's `touched_files[]` are *unrelated* — typically lint autofixes, typo repairs, or adjacent cleanups the user bundled into the cycle commit. Rather than abort (previous behavior, which was hostile to `git commit -am` usage), surface them via a single `AskUserQuestion`:
     - `question`: "Cycle N-1 commit includes <K> path(s) that Claude did not touch: <full path list>. These will be preserved by the terminal soft-reset and ship in the final squash. Keep them as part of this review's squash, or abort for amend-drop?"
     - options:
       - `Keep (continue to cycle N)` — record the extras in `cycle_history[N-1].unrelated_commit_paths[]` for the step-20 Part B audit to surface again at terminal reset. Proceed to cycle N.
       - `Abort to amend` — print `Amend your cycle N-1 commit to drop the unrelated paths, then reply continue.` and pause the skill like the manual-commit gate in step 14.
     Rationale: the hard-abort form of this check rejected normal developer workflows. Warn-and-confirm preserves the signal (user sees unrelated paths per-cycle) without blocking lint-fix-plus-cycle-fix commits. Skipped entirely for V=0 retries.

   On any mismatch of the bullets above, do NOT proceed. Print a compact explanation naming the specific check that failed and re-issue the step 14 manual-commit instruction (or the V=0 restart message). Wait for the user to correct the state and reply `continue`. Do not silently review stale state.

   Then:
   - `variant == review`:
     ```
     node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" review --wait <codex_scope_args>
     ```
     Capture stdout as free-form text.
   - `variant == adversarial-review`:
     ```
     node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" adversarial-review --wait --json <codex_scope_args> "<focus_text_with_context>"
     ```
     `<focus_text_with_context>` is the target-kind focus text from `references/focus-text.md` followed by the `<review_context>` block (see §Review Context Format). Parse stdout as JSON.
   - **Parse-retry policy** (adversarial only): if JSON parsing fails or any required field is missing (`findings[]`, `severity`, `file`, `line_start`, `title`, `recommendation`), retry the exact same call **once**. A second failure aborts the cycle, surfaces codex's raw stdout verbatim to the user, and ends the skill.
9. **Extract findings and assign IDs `F1..Fn`.**
   - `adversarial-review`: use `findings[]` as-is.
   - `review`: Claude manually slices the free-form output into finding blocks. Each block must have a `title` (first line of the block, verbatim), a `recommendation` (the action codex suggests, verbatim), a best-effort `file`, and `line_start` (resolve from context, leave null if codex did not cite a location). Findings without at least a `title` and a `recommendation` are dropped with a note in the summary.
10. **Run the validity check silently.** For every finding, run the six items in `references/validity-checklist.md` **without echoing the per-item trace** to the user. Every item still requires Claude to Read the cited file internally — do not trust codex's body alone — but file reads and item-by-item reasoning are internal only. Assign each finding a three-value outcome: `valid`, `partially-valid`, or `invalid`. Record a short `Claude's note` (≤20 words) for every finding regardless of outcome — for `valid` findings, note the primary reason the finding is grounded (e.g. "confirmed by reading cited lines", "DoD required feature violation"); for `partially-valid`/`invalid`, note the rejection reason. When multiple findings cite the same file, issue a single `Read` call covering the union of cited ranges and reuse the result for every item-2/item-3/item-4 check — do not re-read the same region per finding.

    **External-source rule (warning-only)**: external reads (dependency crate sources, standard library docs, upstream README) are allowed as *background evidence* for Claude's internal reasoning, but they MUST NOT flip the validity verdict. The verdict is always determined from the review diff itself plus what the finding claims. If an external read contradicts or confirms the finding, record it as `Claude's note: background — <source>: <what it showed>` without changing the outcome. The silent-trace rule still holds for validity determined solely from the diff — the `background` note is only emitted when Claude actually consulted an external source. This rule replaces an earlier "External-source exception" that allowed verdict-flipping with version-pinned sources; in practice Claude cannot reliably pin dependency versions, and the safe constraint is to forbid verdict-flipping entirely.

    **No severity-based tiering**: item 3 (premise matches artifact) is mandatory for every finding that could become selectable. Read tiering was considered (skip item 3 on medium/low) but rejected: self-consistency between title and recommendation does not prove the artifact actually has the claimed behavior. Skipping item 3 would let invalid medium/low findings reach the user-selection UI, which is exactly the silent-hallucination failure mode the validity check exists to catch. The Read cost (1 Read per unique cited file, shared across findings in that file via the union rule above) is acceptable; tiering's savings do not justify the safety weakening.
10a. **Run scope triage via `review-scope-guard`.** Invoke `Skill(review-scope-guard)` passing `findings[]` (with the validity outcomes already attached), the cached `dod` (pre-collected in step 7 when variant is adversarial; null on cycle 1 for review variant — the skill will collect it interactively then), the running `rejected_ledger`, `cycle_history` (for stop-signal evaluation), **and `review_target` (already fully constructed in Phase 0 step 2 — pass it verbatim without re-deriving any field)**. Phase 0 step 2 guarantees `review_target` carries the full `{scope, base_ref, base_sha, diff_command, diff_files, diff_numstat, commit_range, commit_messages[], diff_patch_excerpts}` tuple; step 10a simply forwards it. **Do not drop `diff_patch_excerpts`** — scope-guard's proposal-mode evidence gate consumes it for working-tree targets where `commit_messages[]` is empty. The caller MUST pass `review_target` so scope-guard's `proposal` DoD mode has an authoritative source; without it, scope-guard falls back to `interview` mode (see scope-guard §Inputs). The skill returns a triage verdict per finding (`must-fix` / `minimal-hygiene` / `reject-out-of-scope` / `reject-noise`), an updated `rejected_ledger`, a set of active stop signals, and the collected `dod` (on cycle 1). Cache the DoD for later cycles. Store the triage verdicts alongside each finding for step 11. When DoD is missing, the skill still returns classifications inside the 4-category invariant (fall-through lands in `minimal-hygiene`); render the degraded-mode warning as documented in Failure Modes.
11. **Render the summary.** Use the exact table format in §Summary Output Template. Every finding appears in the table, including `invalid` and `reject-*` ones. Every finding's `recommendation` field is quoted verbatim below the table (per §Summary Output Template). The active stop signals footer is rendered when (a) any signal has status `ADVISORY`/`ACTIVE`/`WARNING`, OR (b) any signal is `not evaluated: metrics missing`. Omit the footer only when every signal is truly `silent`. When the footer renders solely due to `not evaluated` rows, print a compact one-line notice — `Not evaluated (metrics missing): <comma-separated signal names>` — instead of the full signal table.

    **Structurally-unevaluable compaction**: subtract `structurally_unevaluable_signal_names` from the `not_evaluated_signal_names` set before rendering. The structurally-unevaluable names are shown once in cycle 1's footer as `_Stop signals unavailable in codex-review-cycle integration: <names> (standalone invocation required for full 5-signal surface)._` and omitted from cycle 2+ footers entirely. This replaces the previous behavior where `file-bloat` / `reactive-testing` appeared in every cycle's `Not evaluated` list.

    Additionally, starting from cycle 2, compare the **current-cycle `not_evaluated_signal_names`** (taken from `review-scope-guard`'s return value received in step 10a of the current cycle — NOT from `cycle_history[current]`, which is only appended later in step 15) against **`cycle_history[N-1].not_evaluated_signal_names`** (the immediately previous cycle, not cycle 1) using the element-wise-equal semantics in `review-scope-guard/references/stop-signals.md` §Per-cycle suppression. Comparing against N-1 (not cycle 1) prevents flapping from being masked: a set that differs from cycle 1 → matches cycle 2 → differs from cycle 3 would otherwise be silently suppressed if only the cycle-1 baseline were checked. This ordering is required because step 11 runs before step 15 persists the current cycle's entry; reading `cycle_history[current]` at step 11 would read stale or empty state. If the two lists are equal, print `_Not evaluated: unchanged from cycle N-1 — see cycle N-1 summary for signal list._` instead of re-listing the names. If they differ, re-render the full list AND add `_Not evaluated delta vs cycle N-1: added=<names>, removed=<names>._` so the change is visible. The canonical order guarantees ordering-only differences cannot occur; guard for them anyway.

    **Validity fleet-rate check** (plan targets only, ≥5 findings): if the current cycle has ≥5 findings and 100% are classified `valid`, print a single-line calibration warning at the bottom of the summary: `⚠️ 100% valid rate with ≥5 findings is unusual for adversarial-review on plan targets. Re-scan for: (1) vague recommendations that should be 'partially-valid: vague', (2) already-handled premise that should be 'invalid: misread', (3) design-intent reversals that should route through scope triage as 'reject-out-of-scope' instead of being accepted as must-fix.` This is a soft prompt, not a hard gate — the cycle proceeds normally. Raised threshold (was ≥3) and plan-only scope prevent false alarms on small focused diffs, where 3 valid findings is a normal outcome.
12. **Zero-valid check.** Let `V` be the count of findings whose validity outcome is `valid` or `partially-valid` **and** whose scope category is `must-fix` or `minimal-hygiene`. `reject-out-of-scope` and `reject-noise` findings are never counted as selectable, even if their validity outcome was `valid`. If `V == 0`:
    - If `N == 3` (final cycle), jump to Phase 2 Case A unconditionally — the cap has fired.
    - If `variant == review` (native), jump to Phase 2 Case A unconditionally. The V=0 override is **not available for native review** because the native `review` command accepts neither a focus-text argument nor a `<review_context>` block — there is no channel to deliver an `<angle_request>` instruction. Re-running the same command against the same diff would be a hidden no-op that still consumes one of the 3 cycles. The override is therefore scoped to `variant == adversarial-review`.
    - If `N < 3` **and** `variant == adversarial-review`, issue a single `AskUserQuestion` before terminating:
      - `question`: "No selectable findings this cycle. Terminate the review, or run one more cycle with a different angle request?"
      - options (translate to user language per §Language):
        - `Terminate now (Case A)` — proceed to Phase 2 Case A.
        - `Run cycle N+1` — proceed to the **no-fix persist step below**, then re-enter step 8 with `N = N + 1`. The next cycle's `<review_context>` carries a one-line `<angle_request>` element: `<angle_request>Prior cycle produced 0 selectable findings. Try a materially different angle — e.g. a deeper root-cause pass, a different subsystem emphasis, or a scope that cuts across files not yet reviewed.</angle_request>` inserted between `<previous_fixes>` and `<rejected_findings>`.

    **No-fix cycle-history persist (before re-entering step 8)**: because V=0 means no selection and no fix phase, step 15's normal persistence never runs. Without explicit persistence here, the next cycle's `<review_context>` and `cycle_history[1]` reference would be stale or empty. Before returning to step 8, append an entry to `cycle_history` for the just-completed cycle with the following shape:
    - `applied_fixes: []` (empty — no fix phase)
    - `user_declined: []` (empty — no selection UI was opened)
    - `skipped_for_scope: []` (empty)
    - `claude_invalid: []` — populated from the current cycle's validity check (findings whose validity was `invalid`). This carries forward into the next cycle's `<rejected_findings>` via the normal union with the ledger.
    - `not_evaluated_signal_names`: the current-cycle return value from `review-scope-guard` step 11 (same value used for the step 11 footer comparison)
    - `pre_pause_head`: `null` for `working-tree`; `git rev-parse HEAD` otherwise (no branch/base-ref pause occurs on V=0 since there were no fixes to commit)
    - **`no_fix_cycle: true`** — explicit marker that this cycle had no fix phase. The cycle-N>1 preflight in step 8 consumes this marker to set `expected_commit = false`: HEAD is required to be UNCHANGED (`HEAD == pre_pause_head`), full working tree required clean (no path restriction), commit-delta and ownership checks skipped. See step 8 §Cycle-N>1 preflight for the full unified rule.

    Also persist the current `rejected_ledger` (which `review-scope-guard` already updated) for the next cycle's forwarding. This persistence is cheap (all buckets are empty except `claude_invalid` and `not_evaluated_signal_names`) but required for `<review_context>` correctness.

    The override path is bounded by the existing 3-cycle cap: requesting cycle N+1 from a V=0 state still consumes one of the 3 cycles. The user cannot escape the cap this way.
13. **Ask the user which findings to fix.** Use `AskUserQuestion(multiSelect: true)` per §User Selection UI. Only findings with scope `must-fix` or `minimal-hygiene` appear as options (further filtered by validity to exclude `invalid`). `reject-out-of-scope` and `reject-noise` findings are never offered for selection — they live in the summary table for audit trail only. Always append a final `None — skip all, end cycle` option.
13.5. **Fix-weight precheck (self-discipline gate).** Before applying any selected finding, verify that the planned edit matches the finding's scope classification. This check runs **silently** — it adds no user-visible output unless a mismatch is detected.
    - `must-fix` allows multi-line edits, new sections, flow changes, and cross-file edits within the review diff.
    - `minimal-hygiene` allows **only** 1-line edits, a single short paragraph addition, or a 1-sentence rule insertion. Edits that exceed this envelope indicate the finding should have been classified `must-fix`, not hygiene, and the rest of the workflow would miscount it.
    - On mismatch (a `minimal-hygiene` finding whose planned fix exceeds the hygiene envelope): either (a) simplify the edit to hygiene-scope and apply, or (b) raise an `AskUserQuestion` asking the user whether to re-classify the finding as `must-fix` before proceeding. Do **not** silently apply a must-fix-weight edit to a minimal-hygiene finding.
    - `reject-*` findings must not trigger any edit — skip entirely.
    - Rationale: without this gate, `minimal-hygiene` findings can receive multi-line structural edits, recreating the over-engineering pattern the skill is designed to prevent. This gate forces the classification and the applied weight to match.
14. **Apply fixes.** For each selected finding, Claude reads the cited lines, applies the fix via `Edit` or `Write`, and reports the resulting `git diff` for the touched files. No sync-sweep, no rescue delegation.

    **Write-scope boundary**: Claude edits only files present in `review_target.diff_command` output (plus untracked files for `working-tree` scope). If a finding's fix genuinely needs an out-of-diff file, skip the finding with a note `Skipped: requires out-of-diff write`. Out-of-diff writes are a scope expansion that must go through a separate skill invocation, not through the user-selection UI.

    How the fixes become visible to the next cycle depends on `review_target.scope`:
    - **`working-tree`**: fixes are left in the working tree. Cycle N+1's `--scope working-tree` review sees the staged + unstaged + untracked state directly. No commit is needed.
    - **`branch` / `base-ref`**: codex's branch diff is computed as `<merge-base>..HEAD`, so in-place edits are invisible until they land in a commit on HEAD. **Claude does not commit on the user's behalf**. Before printing the manual-commit instruction, record `pre_pause_head = git rev-parse HEAD` into `cycle_history[current].pre_pause_head` — the next cycle's preflight uses this anchor (plus the per-fix `touched_files[]` list from step 15) to verify the user's actual commit delta, not just worktree cleanliness. Then, after all selected fixes are applied this cycle, print a manual-commit instruction and pause the skill:
      ```
      Cycle N fixes applied to working tree. Branch/base-ref scopes require you to commit these changes before cycle N+1 can see them. Recommended commands:
        git add <touched files>
        git commit -m "review cycle N fixes"
      After committing, reply `continue` to proceed to cycle N+1. Reply `stop` to end the skill here.
      ```
      The user owns pre-commit hook outcomes, clean-index concerns, and rollback. If the user replies `stop`, end the skill in Case B-like state (applied fixes remain uncommitted in the working tree; the user can deal with them however they like). If the user replies `continue`, proceed to step 8's cycle-N>1 preflight which verifies `git rev-parse HEAD` has moved.

    **Sibling-doc cascade check**: when a fix changes a user-facing contract of the skill (adds a new side effect the skill did not previously have, changes a stated invariant, introduces a step that sibling docs describe as absent), Claude must **in the same edit pass** grep sibling docs (`README.md`, other SKILL.md sections, CHANGELOG entries for the current release) for claims describing the OLD behavior, and update every match. Specifically run `rg -n '<characteristic phrase from old behavior>' .` for at least one phrase, and either edit every hit or leave an explicit NOTE comment explaining why a mismatch is acceptable. Rationale: catching contract-breaking fixes in the same edit pass prevents silent contract breaks that would only surface in a later cycle.
15. **Update cycle history and ledger.** Append to `cycle_history` an entry for this cycle recording:
    - `applied_fixes[]` — each entry records `{fingerprint, title, file, line_start, scope_category, touched_files[]}`. `fingerprint` is the stable `{normalized_title, file, line_start, scope_category}` tuple used by step 17's residual matcher. `touched_files[]` is the exact list of files Claude edited while applying the finding — the preflight in step 8 consumes this list to verify those files are visible in cycle N+1's branch diff.
    - `user_declined[]` — each entry records `{fingerprint, title, file, line_start, scope_category}` for `must-fix`/`minimal-hygiene` findings the user did not select (including the `None — skip all` case).
    - `skipped_for_scope[]` — each entry records `{fingerprint, title, file, line_start, scope_category, reason}` for findings the user selected but Claude skipped because their fix required an out-of-diff write (see step 14 Write-scope boundary). These count as unresolved at termination time — Case A lists them alongside user-declined carry-overs and must not claim clean resolution while the bucket is non-empty.
    - `claude_invalid[]` — each entry records `{fingerprint, title, file, line_start, rejection_reason}` for `invalid` findings from the validity check.
    - `not_evaluated_signal_names[]` — the ordered string array returned by `review-scope-guard` step 11. Stored verbatim, no mutation. Used by step 11's footer rendering in cycle N+1 to decide whether to suppress the `not evaluated` footnote.
    - `unrelated_commit_paths[]` — optional, populated only when the user chose `Keep` at the cycle-N>1 ownership gate. Lists paths from the cycle commit that were NOT in `applied_fixes[*].touched_files[]`. The step-20 Part B terminal audit consumes this list to display the unrelated paths one more time before the final squash, so the user can decide anew whether to include them in the final commit.

    All four buckets carry fingerprints so step 17's residual accounting matches on the stable `{normalized_title, file, line_start, scope_category}` tuple, not on title alone.

    The `rejected_ledger` returned by step 10a is already updated with `reject-out-of-scope` and `reject-noise` entries; persist it as-is for the next cycle. The next cycle's `<review_context>` `<rejected_findings>` block is populated from the union of ledger entries and `claude_invalid` only — **not** from `user_declined[]` or `skipped_for_scope[]`. Declines and out-of-diff skips are deferrals, not rejections: leaving them out of `<rejected_findings>` lets codex freely re-raise the same findings next cycle so the user can reconsider them. Termination-time accounting still tracks them as unresolved residuals (see step 17 Case A).
16. **Loop check.**
    - `N < 3`: set `N = N + 1`, return to step 8.
    - `N == 3`: always jump to Phase 2 Case A. The Case A routing internally chooses between the clean-termination variant and the residual-carried-forward variant based on whether `cycle_history[*].user_declined[]` + `cycle_history[*].skipped_for_scope[]` leave any unresolved residuals (see step 17). Final-cycle user declines are handled by the residual variant, not by Case B — the user explicitly dispositioned each finding through the selection UI, which is an active close-out, not a cap failure.
    - **Case B is reserved** for an explicit cap-stop condition where the cycle could not run the user-selection UI to completion (e.g. the user interrupted mid-paging during an overflow batch, or the skill aborted before step 13). Normal 3-cycle completion with some user declines is Case A residual, not Case B.

### Phase 2 — Termination

17. **Case A — normal termination.** Compute the full residual set: scan `cycle_history[*].user_declined[]` and `cycle_history[*].skipped_for_scope[]` across all prior cycles. For each, compute a stable fingerprint `{normalized_title, file, line_start, scope_category}` (same format as `review-scope-guard`'s ledger fingerprint — reuse that rule). A residual is "carried" if no later cycle's `applied_fixes[]` contains an entry with a matching fingerprint. Matching on title alone is forbidden because generic adversarial titles collide across unrelated findings and could silently clear a residual. If the carried residual set is empty, print `All findings resolved after N cycle(s).` — the clean-termination variant. Otherwise print `Review cycle terminated after N cycle(s) with residuals carried forward.` (never the "resolved" line) followed by `User-declined valid findings carried to termination:` and `Out-of-diff skipped findings carried to termination:` lists, with each entry showing `<title> (<file>:<line_start>, declined in cycle N)` so the user can audit. Either way, also print the mandatory `⚠️ No automated verification was run` warning and the per-cycle applied fixes summary.
18. **Case B — cap reached.** Print the template in §Termination Criteria Case B. Do not automatically start a fourth cycle. Tell the user they can re-invoke the skill to run another 3-cycle pass.

## Review Context Format

Used only when `variant == adversarial-review`. The block is appended to the focus text argument with a single blank line between the two sections:

```xml
<review_context cycle="N">
  <intent><![CDATA[<one-sentence change intent from Phase 0 step 7 DoD item 1>]]></intent>
  <previous_fixes>
    <fix cycle="N-1"><![CDATA[<applied finding title + one-line change summary>]]></fix>
  </previous_fixes>
  <angle_request><![CDATA[<one sentence; present only when V=0 override fired in the previous cycle>]]></angle_request>
  <rejected_findings>
    <rejected cycle="N-1" reason="invalid: file not in diff"><![CDATA[<finding title>]]></rejected>
    <rejected cycle="N-1" reason="reject-out-of-scope: DoD explicit out-of-scope"><![CDATA[<finding title>]]></rejected>
  </rejected_findings>
</review_context>
```

- **`<angle_request>` element (optional)**: present only when the previous cycle terminated at step 12 V=0 and the user chose `Run cycle N+1`. Contains a single sentence asking codex to try a different angle. Omit the element entirely when absent.

**Template note**: this block never carries user-declined findings. A user decline is a deferral — codex should remain free to re-raise the same finding next cycle so the user can reconsider. If a template reader is tempted to add a `<rejected reason="user declined">` element, stop: that would let declined valid findings disappear from subsequent cycles and make Case A falsely claim resolution.

Rules:

- Cycle 1 carries `<intent>` (populated from Phase 0 step 7 DoD item 1 pre-collection); `<previous_fixes>` and `<rejected_findings>` are empty.
- `<review_context>` is preceded by this literal instruction, on its own line: `Do not re-report findings in <rejected_findings> unless you have a materially different angle.`
- Every user-facing string inside `<!-- CDATA -->` is quoted as-is. No JSON encoding. No HTML entity escaping. The CDATA wrapper keeps any `<`, `>`, `&` in codex output from terminating the block.
- This skill does not use a separate skip ledger. `<review_context>` is the only cross-cycle carry.
- **`<previous_fixes>` window**: the block carries **only the immediately prior cycle (N-1)**, not a cumulative history. Cycle 3's `<review_context>` contains the 5 fixes from cycle 2; it does NOT also enumerate cycle 1's fixes. Each `<fix>` element uses the compact form `<fix cycle="N-1" category="must-fix|minimal-hygiene"><![CDATA[<title>: <≤40 word summary>]]></fix>` — summaries longer than 40 words are forbidden. Codex only needs the latest ground truth for cross-cycle suppression; older history would inflate the context block without improving review quality. **V=0 exception**: when `cycle_history[N-1].no_fix_cycle == true` (prior cycle was a V=0 override retry and emitted no fixes), cycle N's `<previous_fixes>` skips the empty cycle N-1 and carries fixes from cycle N-2 instead. Without this exception, codex would lose context of cycle 1's applied fixes when cycle 2 was V=0 no-fix, causing re-surfacing of already-fixed findings in cycle 3.
- **`<rejected_findings>` sources**: the block aggregates two kinds of prior-cycle rejections — (1) entries in the `rejected_ledger` returned by `review-scope-guard` (scope-triage rejections: `reject-out-of-scope` / `reject-noise`), and (2) `claude_invalid[]` from the prior cycle's validity check. Each rejection renders as its own `<rejected>` element with the `reason` attribute carrying the original category and rationale (e.g. `reason="reject-out-of-scope: DoD explicit out-of-scope"`, `reason="invalid: file not in diff"`). Ledger entries with `count >= 2` render with an extra hint: `reason="reject-noise: already-rejected (count=N)"` so codex sees how persistent the complaint is. **User-declined findings are NOT included** — a decline is a deferral, not a rejection, and codex is free to re-raise the same finding in the next cycle so the user can reconsider it.

## Validity Check Summary

Full details live in `references/validity-checklist.md`. The six items are:

1. **File exists in the diff** — `finding.file` appears in the output of `review_target.diff_command` (plus `git ls-files --others --exclude-standard` when `review_target.scope == working-tree`).
2. **Line range exists** — `finding.line_start` is within the current file length; flag shifted ranges as `partially-valid`.
3. **Premise matches artifact** — Claude reads the cited lines and confirms codex's assertion.
4. **Scope** — `line_start..line_end` overlaps a changed hunk in the scope-appropriate diff (`git diff HEAD -- <file>` for working-tree; `git diff <base_sha>...HEAD -- <file>` for branch / base-ref, using the frozen Phase-0 SHA), not unchanged code in a touched file.
5. **Recommendation concreteness** — a specific failure mode is named, not a vague "consider…".
6. **Target-kind consistency** — plan cycles reject detailed-design nitpicks on `.md`/`.markdown`/`.txt` files.

Outcome: `valid` (all pass), `partially-valid` (items 2 or 5 returned partially-valid, no `invalid`), `invalid` (any of items 1, 3, 4, 6 returned invalid).

## Summary Output Template

**Language reinforcement**: the template below uses English for readability of the SKILL.md spec itself. When rendering actual output, translate ALL non-verbatim elements to the user's language per §Language: section headers, column headers (except `Title (codex verbatim)`), `Claude's note` content, `Recommended action` values, the recommendation block heading, stop-signal footer text, and termination messages. Only codex's `title` and `recommendation` fields stay in their original language (they are contractually verbatim).

Render after every cycle, before the user selection prompt:

```markdown
### Cycle N review summary (variant: <review|adversarial-review>, target: <code|plan>)

| ID | Severity | File:Line | Title (codex verbatim) | Validity | Scope | Claude's note | Recommended action |
|----|----------|-----------|------------------------|----------|-------|---------------|--------------------|
| F1 | high     | src/auth/login.ts:42 | Missing null check on userId    | valid            | must-fix            | DoD required features; core correctness        | Apply fix            |
| F2 | medium   | src/api/user.ts:88   | Consider adding retry logic     | partially-valid  | reject-noise        | vague, no concrete failure mode                 | Skip                 |
| F3 | low      | docs/plan.md:15      | Rename process to handler       | invalid          | reject-noise        | detailed-design on plan target                  | Skip                 |
| F4 | medium   | src/curl.rs:130      | --url-query value leaks to URL  | valid            | minimal-hygiene     | value consume + warn; semantics NOT implemented | Apply 1-line hygiene |
| F5 | medium   | src/curl.rs:120      | Implement --json shorthand body | valid            | reject-out-of-scope | DoD explicit out-of-scope: cURL 7.82+ new       | Skip (ledger fwd)    |

**Recommendation (per finding)**:

- **F1**: <codex recommendation verbatim>
- **F2**: <codex recommendation verbatim>
...

Quote every finding's `recommendation` field verbatim below the table. Do not skip quoting even when the title seems to imply the recommendation — the user needs the full recommendation text to make an informed fix/decline decision without reading the raw codex JSON.

**Active stop signals** (footer rendered when ≥1 signal is `ADVISORY`/`ACTIVE`/`WARNING` **or** `not evaluated: metrics missing`; omit entirely only when all signals are truly `silent`. When only `not evaluated` rows exist, replace the full table with a compact one-liner `Not evaluated (metrics missing): <names>`):

| Signal | Status | Evidence |
|--------|--------|----------|
| ...    | ...    | ...      |
```

### Format rules that protect finding intent

- The `Title (codex verbatim)` column must contain codex's `title` field exactly. No paraphrase, no shortening, no translation.
- The `Recommendation (per finding)` block must contain each finding's full `recommendation` field verbatim, regardless of length. Never truncate, summarize, or abbreviate — the user needs the complete remediation text to make an informed fix/decline decision.
- Claude's interpretation lives only in the `Claude's note` column and the `Recommended action` column. Do not edit any other column based on what Claude thinks the finding "really means".
- If Claude judges a finding `invalid`, the row still appears in the table with the original title and recommendation. The `Claude's note` column then carries `invalid because <reason>`.
- If `review-scope-guard` classifies a finding as `reject-out-of-scope` or `reject-noise`, the row still appears in the table for audit. The `Scope` column carries the category and `Claude's note` carries the triage rationale verbatim from the skill's output.
- Severity values come from codex. Do not upgrade or downgrade severity based on Claude's validity or scope verdict.

## User Selection UI

**Language reinforcement**: `AskUserQuestion` `question`, `header`, and option `label`/`description` fields must be in the user's language per §Language. Codex verbatim titles embedded in labels stay in their original language.

Use `AskUserQuestion` with `multiSelect: true`. Only findings whose **scope** is `must-fix` or `minimal-hygiene` AND whose **validity** is `valid` or `partially-valid` appear as options. `invalid`, `reject-out-of-scope`, and `reject-noise` findings are never selectable — the user sees them in the summary table above for audit trail only.

`minimal-hygiene` options include a `(hygiene)` marker in the label so the user knows the expected fix is 1-line value consume + warn, not a full implementation.

Base layout. **Token rule**: each option's `description` field must carry only the finding's `file:line` — nothing else. The label already encodes the title, severity, and scope; the summary table above already carries rationale and Claude's note. Repeating any of that in the description is wasted context.

```text
question: "Which findings should I address in cycle N?"
header: "Cycle N fixes"
multiSelect: true
options:
  - { label: "F1: Missing null check on userId (high, must-fix)",            description: "src/auth/login.ts:42" }
  - { label: "F4: --url-query value leaks to URL (medium, hygiene)",         description: "src/curl.rs:130" }
  - { label: "None — skip all, end cycle",                                   description: "End this cycle" }
```

### Overflow handling (more than 3 selectable findings per severity)

`AskUserQuestion` accepts maximum 4 options per question; reserve one for `None — end cycle`, leaving 3 finding slots per question. When a severity bucket has more than 3 selectable findings, issue multiple sequential `AskUserQuestion` calls (3 findings each) in severity order until every selectable finding has been surfaced. No finding may be silently deferred just because it did not fit on a page — the fix phase does not begin until every selectable finding has been shown to the user and either applied or declined.

## Termination Criteria

**Language reinforcement**: the templates below are in English for spec readability. Actual output must be in the user's language per §Language. Translate all headings, messages, and labels; keep codex verbatim titles and technical identifiers (`must-fix`, `minimal-hygiene`, file paths) as-is.

**Case A — V == 0 (normal termination)**:

When the residual set (carried user-declined + carried out-of-diff skipped) is empty:

```
All findings resolved after N cycle(s).

⚠️ No automated verification was run. This skill never executes tests, lints, builds, or any verification command on behalf of the user. The "resolved" claim only means "codex returned zero selectable findings this cycle and no residuals were carried from prior cycles". Before shipping, review the applied diff and run your own verification (test suite, type check, lint, build, manual smoke) as appropriate for the change.

Applied fixes by cycle:
- Cycle 1: <list of finding titles or "none">
- Cycle 2: <list or "none">
- Cycle 3: <list or "none">
```

When any residuals exist (declined carry-overs, out-of-diff skips, or final-cycle declines), swap the opening line and list the residuals — do NOT print "All findings resolved":

```
Review cycle terminated after N cycle(s) with residuals carried forward.

⚠️ No automated verification was run. See the clean-termination variant above for rationale.

Applied fixes by cycle:
- Cycle 1: <list of finding titles or "none">
- Cycle 2: <list or "none">
- Cycle 3: <list or "none">

User-declined valid findings carried to termination: <titles from cycle_history[*].user_declined[] that never appear in a later cycle's applied_fixes[], or "none">
Out-of-diff skipped findings carried to termination: <titles from cycle_history[*].skipped_for_scope[] that never appear in a later cycle's applied_fixes[], or "none">
```

**Case B — 3 cycles complete with unresolved valid findings**:

```markdown
## Review cycle terminated — cap reached

- Cycles run: 3 / 3
- Findings applied: <count>
- Findings still valid and unresolved at cap: <count>

⚠️ No automated verification was run on the applied fixes — see Case A for rationale.

### Unresolved valid findings

<Summary Output Template table, filtered to valid/partially-valid findings that were never applied>

### Next steps

- Re-run `codex-review-cycle` after further work, or
- Address the unresolved findings manually, or
- Explicitly accept them as known residuals.
```

The skill never advances to a fourth cycle. The user must invoke the skill again to continue.

19. **Review assessment.** After printing Case A or Case B output, render a concise review assessment block **in the user's language** (per §Language) to help the user decide whether to re-invoke the skill or move on:

    ```
    ## Review assessment

    **Trend**: <1 sentence — e.g. "converging (5 → 4 → 3, severity shift from high to medium)", "stable (structural gaps in each cycle)", "cascading (cycle N fixes created cycle N+1 findings)">

    **Character**: <1 sentence — e.g. "mostly state-model gaps", "edge cases and design-philosophy arguments", "doc/wording consistency issues">

    **Clusters** (optional — render only when ≥2 **rejected-ledger** entries share a `cluster_id`): `<cluster_id>`: <N> ledger entries across <M> cycle(s) (see ledger entries L<i>, L<j>, ...). Emit at most 3 cluster lines, sorted by finding count descending. If no cluster has ≥2 members, omit the line entirely. **Scope limitation**: cluster accounting is intentionally limited to rejected-ledger entries because only those carry `cluster_id` (see `review-scope-guard` Phase 3 step 9 assignment rule). Applied-fix findings do not participate in cluster summary; extending the carrier to applied fixes is deliberately deferred to avoid inconsistent partial counts.

    **Recommendation**: <"continue reviewing" | "stop and audit scope" | "move to next work" with 1-sentence rationale. Determined from recorded state only:
    - If any `must-fix` or `minimal-hygiene` residual was carried to termination → "address residuals before shipping"
    - If any stop signal is `ACTIVE` or `WARNING` → "stop and audit scope" (aligns with review-scope-guard's stop-signal contract: ACTIVE/WARNING means diminishing returns or scope drift, not a reason to run more cycles)
    - If clean termination (no residuals) AND finding count decreased across cycles AND no stop signal tripped → "move to next work"
    - Otherwise → "continue reviewing" (default-safe)>

    **Suggested next action**: <concrete 1-line action — e.g. "squash and merge to main", "run 1-cycle working-tree dogfood on the applied fixes", "address the 2 carried residuals manually before merging">
    ```

    This block is advisory — it does not gate any action. Keep each part to one sentence; do not re-list findings or repeat the termination summary.

20. **Soft-reset temporary cycle commits** (`branch` / `base-ref` only). During the review run, the user created one commit per cycle at Claude's request (step 14 manual-commit pause). These are intermediate review-cycle artifacts, not the user's intended final commit. To keep the applied code changes while removing the intermediate commit history:
    - If `review_target.scope == working-tree` or no cycle commits were created, skip this step silently.
    - **Terminal-cycle verification**: before resetting, verify the final cycle's applied fixes were actually committed. Run `git status --porcelain -- <final cycle's touched_files>`. If any files have uncommitted changes, print `⚠️ Final cycle has uncommitted applied fixes (<file list>). Soft-reset will NOT stage these — only committed changes become staged after reset. Commit them first, or they will be lost from the staged state.` and skip the reset with a manual-squash fallback: `git reset --soft <pre_cycle_1_head>`.
    - Retrieve `pre_cycle_1_head` from Phase 0 step 7 and record the current `HEAD` as `final_head`.
    - **Dirty-state audit (pre-preview)**: before preview, confirm no non-cycle-owned state would be staged by the reset. Compute `cycle_owned_files` = union of `cycle_history[*].applied_fixes[*].touched_files[]`, then:
      - **Part A (uncommitted)**: run `git status --porcelain` and inspect every entry:
        - Entries that refer to files **outside** `cycle_owned_files` are **unrelated uncommitted state** that would survive `git reset --soft`.
        - Entries that refer to files **inside** `cycle_owned_files` are also **blocking** unless they are the final cycle's applied-fix files that the Terminal-cycle verification above already cleared. Any staged/unstaged edit on an **earlier-cycle** cycle-owned file (or on a final-cycle file that the Terminal verification failed on) bypasses `git reset --soft` — soft-reset preserves the index and working tree but will NOT stage an unstaged edit, so the workflow's "all applied fixes are staged" claim becomes false. Surface every such entry in the abort output below, including staged vs unstaged status, so the user can commit/stash before re-running.
      - **Part B (committed-range ownership)**: run `git diff --name-only <pre_cycle_1_head>..<final_head>` and compare against `cycle_owned_files`. Any path in the committed delta that is **NOT** in `cycle_owned_files` is an unrelated file the user accidentally included in a cycle commit; `git reset --soft` will stage it into the final squash without the preview flagging it (the preview only shows `--stat`, which lists filenames but does not cross-check ownership). Part B catches what Part A cannot: unrelated work already committed into the cycle range. Paths present in `cycle_history[*].unrelated_commit_paths[]` (user-approved during cycle-N>1 ownership gate) are NOT treated as abort-worthy at Part B — they already got a user decision. Part B surfaces them in the preview output with a `(user-approved unrelated)` tag so the final squash commit accurately reflects what is being shipped.
      - If either Part A or Part B reports entries outside `cycle_owned_files`, print the following and abort the soft-reset entirely:
        ```
        ⚠️ State outside the cycle-owned files detected. `git reset --soft <pre_cycle_1_head>` would preserve this into the final staged index, mixing unrelated work into what looks like a "cycle-only" squash.

        State leaking into the soft-reset target:
        <list every entry with its source tag: [A-uncommitted] / [A-dirty-owned] / [B-committed] — one per line; if all three categories are empty this entire abort block is not printed>

        Resolve before continuing:
         - [A-uncommitted] paths: commit, stash, or clean them.
         - [A-dirty-owned] paths: commit or clean the staged/unstaged remnants on cycle-owned files.
         - [B-committed] paths: amend the offending cycle commit to drop the unrelated file, OR rewrite the commit range to exclude it, OR explicitly include them in a manual post-reset commit by running `git reset --soft <pre_cycle_1_head>` yourself after clearing [A-*].
        Re-invoke the skill after the range is cycle-clean.
        ```
      - Stop the skill here (do NOT proceed to preview or reset) until the user fixes the state and re-invokes. The soft-reset preview gate gives false confidence if the preview shows only the cycle diff while the actual post-reset staged index would contain unrelated work (uncommitted OR committed).
    - **Soft-reset preview (confirmation gate)**: only reached when the dirty-state audit passes. Before running `git reset --soft`, show the user what will be squashed. Run `git log --oneline <pre_cycle_1_head>..<final_head>` to list the cycle commits, and `git diff --stat <pre_cycle_1_head>..<final_head>` to show the cumulative change. Print:
      ```
      About to soft-reset <N> cycle commit(s) onto <pre_cycle_1_head>.

      Why squash: the cycle commits (`review cycle 1 fixes`, `review cycle 2 fixes`, ...) are intermediate artifacts of the review loop. Most users want a single final commit that represents the applied change; soft-reset preserves every line of every cycle fix in the staged index, so you can write the final commit message yourself. Declining keeps the cycle commits in place if you prefer their granular history.

      After reset, all changes below are staged in the index (working tree unchanged). You create your own commit message.

      Commits to be collapsed:
      <output of git log --oneline ...>

      Cumulative change (will be staged):
      <output of git diff --stat ...>
      ```

      **Approved-unrelated paths notice** (only when `cycle_history[*].unrelated_commit_paths[]` is non-empty): before the main reset prompt, display an informational section:
      ```
      Approved unrelated paths from earlier cycles (user-tagged during cycle-N>1 ownership gate):
        - <path> (approved in cycle N)
        - ...
      These files are NOT in any applied fix's touched_files. They were bundled into cycle commits and will be preserved by the soft-reset into the final staged index. If you changed your mind about including them, decline the next prompt and amend the cycle commits manually.
      ```
      This is a display-only notice, not an AskUserQuestion — the user already tagged these paths as approved during the cycle-N>1 ownership gate. The main reset prompt below is the opportunity to back out.

      Then issue the main reset `AskUserQuestion`:
      - `question`: "Collapse these N cycle commit(s) into a staged index, ready for your commit?"
      - options:
        - `Yes, soft-reset now` — proceed to the next bullet.
        - `No, leave cycle commits as-is` — skip the reset; print `Cycle commits left in place. Squash manually with `git reset --soft <pre_cycle_1_head>` if desired.` and end the skill.
    - Run `git reset --soft <pre_cycle_1_head>`. This removes all intermediate cycle commits from HEAD but leaves the accumulated changes staged in the index. The user's working tree is unchanged.
    - Print:
      ```
      Soft-reset: <N> temporary cycle commit(s) (<pre_cycle_1_head>..<final_head>) removed.
      All applied fixes are staged in the index. Create your own commit:
        git commit -m "<your message>"
      ```

## Preconditions Recap

- Git CLI available on `PATH`.
- Current working directory inside a git repository.
- The chosen review target produces a non-empty diff: either uncommitted changes exist (`working-tree`), or HEAD is ahead of the auto-detected default branch (`branch`), or the user-supplied ref exists and `<ref>...HEAD` is non-empty (`base-ref`).
- Codex plugin installed and `Skill(codex:setup)` reports a ready state.
- `review-scope-guard` skill available (invoked at step 10a for scope triage and DoD collection).
- Both `codex-review-cycle` and `review-scope-guard` are registered with the Claude Code harness. If not (e.g. during local development before marketplace publication), follow the SKILL.md steps manually — every step is self-contained.

## Failure Modes

- **Codex CLI missing or setup incomplete** — stop in Phase 0 step 4. Tell the user to install the codex plugin or run `/codex:setup`.
- **Default branch not detected** (scope = `branch`) — stop in Phase 0 step 2 with guidance to re-run with scope = `base-ref` and an explicit ref.
- **User-supplied ref not found** (scope = `base-ref`) — stop in Phase 0 step 2 with `Base ref '<ref>' not found in this repository.`
- **JSON parse failure (adversarial)** — retry once; a second failure aborts the cycle with codex's raw stdout surfaced verbatim.
- **File cited by codex no longer exists** — item 1 of the validity check returns `invalid: file not in diff`. The finding is listed in the summary but not selectable.
- **User has no working-tree diff after a cycle's fixes are applied** (scope = `working-tree`) — continue to the next cycle anyway (the next review will see the committed state). Do not silently skip cycles. For `branch` / `base-ref` scopes the diff is against a committed base, so in-cycle fixes never empty the diff.
- **User declines every finding across all 3 cycles** — terminate in Case A with the user-declined message, not Case B. The cap did not fire; the user actively closed the loop.
- **User declines the DoD interview in cycle 1 step 7 (adversarial) or step 10a (review)** — `review-scope-guard` stays inside the 4-category invariant: fall-through findings still classify as `minimal-hygiene`, and ledger/vague findings still classify as `reject-noise`. No 5th `unclassified` bucket is created. The summary table footer prints `⚠️ DoD not collected — scope triage degraded. Review each selectable finding manually before applying; the minimal-hygiene fall-through is weaker than a DoD-anchored classification.` The user is the last line of defense in this degraded mode.
- **Stop signal `ACTIVE` or `WARNING` during cycles 1-2** — print the recommendation in the summary but do not auto-stop. The cycle cap still governs termination.
- **User chooses `Run cycle N+1` from a V=0 state but codex again returns 0 selectable findings** — the next V=0 offer is still issued per step 12 (adversarial-review variant only); the user can choose to terminate or burn another cycle. The cap still governs. Do not suppress the offer just because it fired before.
- **V=0 fires under `variant == review`** — the override path is unavailable; skip directly to Phase 2 Case A as documented in step 12. The summary row for the cycle still renders, and the final `Review assessment` should note "V=0 under native review — override disabled, see step 12" so the user understands why no cycle N+1 offer appeared.
- **`no_fix_cycle: true` entry is internally inconsistent** — corruption is defined by **same-entry contradiction**, not by comparison with earlier cycles. A valid applied-then-V=0-retry sequence (`cycle 1: applied_fixes non-empty` → `cycle 2: no_fix_cycle=true, applied_fixes=[]` → `cycle 3: uses cycle-2 marker to exempt preflight`) must be honored — cycle 2 having a no-fix marker while cycle 1 had fixes is NORMAL. Treat the marker as corrupted ONLY when the **same entry** that carries `no_fix_cycle: true` also has non-empty `applied_fixes[]`, `user_declined[]`, or `skipped_for_scope[]`. In that (truly contradictory) case, print `⚠️ Inconsistent no_fix_cycle marker on cycle N-1 (marker true but the same entry has applied/declined/skipped entries). Running full preflight.` and run the full preflight ignoring the marker. This is defense-in-depth against a corrupted state writer; normal applied-then-V=0 flow is untouched.
- **Conversation context is lost mid-run (e.g. compaction, tab close, long idle)** — the skill's state (cycle_history, rejected_ledger, review_target, dod) lives only in the active conversation. If context is truncated or the session resets, the in-flight run CANNOT be resumed automatically. Recovery steps: (1) if any cycle commits exist on `branch` / `base-ref` scope, the user may squash them manually with `git reset --soft <pre_cycle_1_head>` from `git reflog`; (2) if applied fixes sit uncommitted on `working-tree` scope, they stay in place and the user commits normally; (3) restart the skill from Phase 0 on the current state — the new run does NOT know about prior cycles' rejected_ledger, so codex may re-raise findings that the earlier run rejected as noise. State persistence across session breaks is deferred to a separate plan; this bullet documents the current fallback.
- **User wants to cancel the skill mid-cycle** — at any `AskUserQuestion` prompt, the user can type a message indicating cancellation (e.g. "stop", "cancel", "abort"); Claude treats this as an early termination request. The current cycle's state is preserved as-is (no auto-rollback of applied fixes; no auto-commit). Claude prints a short summary: "Skill cancelled at cycle N step M. Applied fixes in this session: <list>. Remaining state: <working-tree dirty | N cycle commits on <branch>>. Manual cleanup may be needed depending on your preferences (git stash, git reset, amend, etc.)." The skill does NOT attempt any destructive cleanup on behalf of the user. Between-prompts cancellation (user Ctrl-C or tab close without an active prompt) falls under the "Conversation context is lost mid-run" bullet.

## References

- `references/focus-text.md` — target-kind detection and the canonical code/plan focus text.
- `references/validity-checklist.md` — full details of the six validity items.
- `references/summary-samples.ja.md` — 日本語で render する場合の summary table / stop signal footer / 終了メッセージ例。
- `skills/review-scope-guard/SKILL.md` — scope triage skill invoked at step 10a (DoD collection, 4-category triage, rejected ledger, stop signals).
