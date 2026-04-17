# Validity Checklist

Claude evaluates every finding codex returns against these six items before the summary table is rendered. The checklist is the filter that prevents Claude from surfacing misread, out-of-scope, or target-mismatched findings to the user. **Every item requires Claude to read the cited file with the `Read` tool** — do not judge validity from codex's `body` alone.

## The Six Items

### 1. File exists in the review diff

`finding.file` must be present in the output of `review_target.diff_command` (plus `git ls-files --others --exclude-standard` when `review_target.scope == working-tree`). Concretely:

- `working-tree`: `git diff HEAD --name-only` or `git ls-files --others --exclude-standard`.
- `branch` / `base-ref`: `git diff --name-only <base_ref>...HEAD`.

If codex cites a file that is not part of the current diff:

- Outcome: `invalid: file not in diff`
- Rationale: the review scope is fixed at Phase 0. Findings on unchanged files are out-of-scope by definition, regardless of which target mode the user picked.

### 2. Line range exists

Read `finding.file` and confirm `finding.line_start` falls within the current line count. If the line number is off the end of the file, or the lines have clearly shifted (e.g. codex cites a line that now contains unrelated content):

- Outcome: `partially-valid: line moved, please verify`
- Rationale: codex may have reviewed a stale snapshot. The underlying concern may still be real but the user needs to inspect the new location.

### 3. Premise matches the artifact

The finding's `body` typically asserts that the code or plan "does X" or "fails to do Y". Read the cited lines and verify the assertion. If the artifact already handles the issue, or the assertion describes behavior that does not exist in the cited region:

- Outcome: `invalid: misread (artifact says X, not Y)`
- Rationale: adversarial-review sometimes hallucinates a failure mode the code does not have. Silent skipping these is the exact failure mode this checklist exists to catch.

**Note on design-intent reversals**: a finding whose premise is "the artifact should have X" while the artifact explicitly states "we deliberately do not have X" is NOT `invalid` at item 3 — the premise matches what the artifact says, modulo an "ought" vs. "is". Route design-intent reversals through scope triage: `review-scope-guard` will classify them as `reject-out-of-scope` when DoD agrees with the exclusion, or as `must-fix` when DoD required features ask for the excluded capability (indicating the DoD and the Overview disagree, which the user must adjudicate). Classifying them `invalid` at validity would silently remove a scope-decision finding from the user-selection UI.

### 4. Scope — finding touches changed lines

Even when `finding.file` is in the diff, the specific `line_start..line_end` range must overlap with a changed hunk. Confirm with the scope-appropriate diff command:

- `working-tree`: `git diff HEAD -- <file>` (staged + unstaged). Untracked files are entirely "changed" — any line range inside them overlaps by definition.
- `branch` / `base-ref`: `git diff <base_ref>...HEAD -- <file>`.

A finding about unchanged code elsewhere in a modified file is:

- Outcome: `invalid: out-of-scope (unchanged code)`
- Rationale: the review is on the diff, not on the full state of files that happen to be touched. Unchanged code is someone else's problem, not this change's.

### 5. Recommendation is concrete

The finding's `recommendation` must name a specific failure mode, symptom, or user-visible impact. Vague suggestions like "Consider adding retry logic", "You might want to validate this", or "Think about error handling here" — without naming a concrete case where the absence bites — are:

- Outcome: `partially-valid: vague, no concrete failure mode`
- Rationale: the user can still choose to address a vague suggestion, but they need to know Claude could not verify a real harm. Do not escalate these to `valid`; do not downgrade them to `invalid`.

### 6. Target-kind consistency (applies per-file, not only to pure-plan cycles)

Item 6 is a **per-finding file-extension filter**, not a cycle-level gate. Regardless of whether the overall `target_kind` is `plan` or `code`, any finding whose `file` is `.md`, `.markdown`, or `.txt` must be evaluated against the plan-level detailed-design exclusion: reject if the finding is implementation-detail nitpick (pseudo-code suggestions, field mutability comments, enum completeness checks, specific method signatures, naming or wording improvements). These are the finding classes the plan focus text explicitly excludes, and they are still out-of-bar for markdown files even when the cycle runs under the code focus text.

- Outcome: `invalid: detailed-design on plan-style file`
- Rationale: the quality bar we enforce for `.md` files is design-level discussion, never line-level documentation polishing. This is the downstream backstop that matches the `Target Kinds` section of SKILL.md (which claims item 6 filters markdown findings in mixed code+plan cycles). Running per-file instead of per-cycle keeps the two descriptions consistent and closes the mixed-target loophole where plan-level markdown findings would slip through under code-review rules.

For findings whose file is a code extension (e.g. `.ts`, `.go`, `.rs`), item 6 always passes — the plan-level detailed-design filter only applies to markdown-family files.

## Three-Value Outcome

After running all six items, map to one of:

- **`valid`** — every item passed. The finding is grounded, in-scope, concrete, and target-appropriate. Surface to the user with `Apply fix` as the recommended action.
- **`partially-valid`** — at least one item returned a `partially-valid` outcome (items 2 and 5) but no item returned `invalid`. The finding is real enough to surface but the user must decide. Recommended action: `User decides`.
- **`invalid`** — at least one item returned `invalid` (items 1, 3, 4, 6). The finding is excluded from the user selection UI. Still list it in the summary table so the user sees the rejection rationale and can override by typing a custom response.

## What Claude Must Not Do

- **Do not paraphrase the finding title or recommendation** while evaluating validity. Keep codex's words verbatim in the summary table; put your verdict in a separate `Claude's note` column.
- **Do not silently drop findings.** Every finding codex returned appears in the summary, even `invalid` ones. The user must be able to see what was rejected.
- **Do not escalate `partially-valid` to `valid` based on severity.** A vague `high` finding is still vague; severity does not compensate for missing ground truth.
- **Do not downgrade `valid` to `partially-valid` because the fix looks hard.** Hardness is a fix-phase concern, not a validity concern.
