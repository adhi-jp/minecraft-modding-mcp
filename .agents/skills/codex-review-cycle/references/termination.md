# Termination Criteria

**Language reinforcement**: the templates below are in English for spec readability. Actual output must be in the user's language per SKILL.md §Language. Translate all headings, messages, and labels; keep codex verbatim titles and technical identifiers (`must-fix`, `minimal-hygiene`, file paths) as-is.

**Render order for every termination variant (Case A clean, Case A residuals, Case B)**: (1) verdict headline (see §Verdict Headline), (2) variant-specific body block, (3) §Verification Disclaimer, (4) §Applied-Fixes List, (5) residual / unresolved lines when applicable, (6) step 19 §Review Assessment, (7) step 20 soft-reset.

**Step 20 visibility**: for `branch` / `base-ref` scopes, step 20 renders its user-facing output — Terminal-cycle verification warning, Dirty-state audit abort, Approved-unrelated paths notice, Soft-reset preview and confirmation `AskUserQuestion`, post-reset summary. Silent-skip (zero output) applies only when `review_target.scope == working-tree` OR no cycle commits were created. Hiding step 20 under other conditions strands cycle commits or reset prompts.

**Trailing-prose prohibition**: do not append free-text summary, recap, or narrative after the sequence. No "Summary" paragraph, no "what I did" recap, no commentary that duplicates §Applied-Fixes List, §19 Review Assessment, or Suggested next action. This prohibition does not silence step 20 under the visibility rule above.

## Case A — V == 0 (normal termination)

When the residual set (carried user-declined + carried out-of-diff skipped) is empty:

```
✅ <Clean-termination label translated> · <cycles label translated> <M> · <F> <fixes-applied label translated> · <trend label translated>: <trend_keyword translated>

<Verification Disclaimer rendered verbatim per subsection below>

<Applied-fixes heading translated>:
- <Cycle label translated> 1:
  - F<n> (<scope_category>) <codex title verbatim>
  - F<m> (<scope_category>) <codex title verbatim>
- <Cycle label translated> 2: <no-fix label translated>
- <... one outer bullet per cycle in `cycle_history`; sub-bullets OR the no-fix label, per §Applied-Fixes List>
```

When any residuals exist (declined carry-overs, out-of-diff skips, or final-cycle declines), swap the verdict keyword and list the residuals — do NOT use the clean-termination keyword:

```
⚠️ <Terminated-with-residuals label translated> · <cycles label> <M> · <F> <applied label translated> / <R> <residual label translated> · <trend label>: <trend_keyword translated>

<Verification Disclaimer rendered verbatim>

<Applied-fixes heading>:
- <Cycle label> 1: <sub-bullets or no-fix label per §Applied-Fixes List>
- <Cycle label> 2: <...>
- <... one outer bullet per cycle in `cycle_history`>

<User-declined-residuals heading translated>:
- F<n> (<scope_category>) <codex title verbatim> — <file>:<line_start>, <declined-in-cycle label translated> <N>
- <... one nested sub-bullet per user-declined residual that never reappeared in a later cycle's applied_fixes[]; render the no-fix label as a single-line bullet when the set is empty>
<Out-of-diff-skipped-residuals heading translated>:
- <same per-entry sub-bullet format, sourced from cycle_history[*].skipped_for_scope[] that never reappear in applied_fixes[], or the no-fix label when empty>
```

## Case B — user-elected termination after the final cycle (V[M] > 0)

Reached only from `SKILL.md` step 16's `N >= 2` branch when the user picked `End the review` at the §Final-cycle Assessment decision prompt. `V[M] > 0` is guaranteed because step 12 routes any final-cycle V == 0 to Case A directly; reaching this case means at least one selectable finding existed on the terminal cycle. `<U> == 0` is a valid sub-state — every selectable finding was applied this cycle but the user chose to stop rather than running another cycle to verify the fixes.

```markdown
⚠️ <Cap-reached label translated> · <cycles label> <M> · <A> <applied label> / <U> <unresolved label> · <trend label>: <trend_keyword translated>

<Verification Disclaimer rendered verbatim>

<Applied-fixes heading translated>:
- <Cycle label translated> 1: <sub-bullets or no-fix label per §Applied-Fixes List>
- <Cycle label translated> 2: <...>
- <... one outer bullet per cycle in `cycle_history`>

- <Cycles-run label translated>: <M>
- <Findings-applied label translated>: <A>
- <Findings-still-valid-and-unresolved label translated>: <U>

### <Unresolved-valid-findings heading translated>

<When <U> >= 1: render finding blocks per `references/summary-template.md` for the unapplied valid/partially-valid findings. When <U> == 0: render a single line `<No-unresolved label translated>` (canonical English: `No unresolved findings.`). The heading renders in both cases.>

### <Next-steps heading translated>

- <Re-run label translated>, or
- <Address-manually label translated>, or
- <Accept-as-residuals label translated>.
```

The skill ends here. The user re-invokes the skill to start a fresh run.

## Verdict Headline

Every termination variant opens with a single-line verdict headline, computed before any body block renders. The reader gets the run outcome at a glance.

Three verdict keywords; exactly one applies per run. `V[M]` is the step-12 V on the terminal cycle, persisted as `cycle_history[M].selectable_count`:

| Condition | Verdict keyword | Emoji |
|-----------|-----------------|-------|
| `V[M] == 0` AND residual set empty (step 12 → Case A) | `Clean termination` | ✅ |
| `V[M] == 0` AND residual set non-empty (user-declined or out-of-diff skipped carry-overs; step 12 → Case A) | `Terminated with residuals` | ⚠️ |
| `M >= 2` AND `V[M] > 0` AND user picked `End the review` at the step-16 §Final-cycle Assessment decision prompt → Case B. Sub-states: `<U> > 0` (some terminal findings unresolved) or `<U> == 0` (every terminal finding applied; the user chose to stop rather than run another cycle to verify). | `Cap reached` | ⚠️ |

The rows are mutually exclusive: step 12 routes to Case A only on V == 0; step 16 routes to Case B only on V[M] > 0 with a user-elected end. The `Cap reached` keyword reads as "review stopped with selectable findings unresolved" and applies whether the stop is a hard cap or a user-elected End — both conditions leave findings on the table.

Headline fields:

- **Emoji** — ✅ or ⚠️ per the table. Literal; never translated, never dropped.
- **Verdict keyword** — translated per `SKILL.md` §Language.
- **`cycles <M>`** — `<M>` is the executed-cycle count (1, 2, or any user-elected extension). `cycles` translates; `<M>` stays literal. No `/N` denominator: the cap is dynamic once the user can elect extensions, so the executed count alone carries the run length.
- **Counts segment** — varies by verdict:
  - Clean termination: `<F> fix(es) applied`. `<F>` = `sum(len(cycle_history[i].applied_fixes))`.
  - Residuals: `<F> applied / <R> residual`. `<R>` = carried user-declined + carried out-of-diff skipped.
  - Cap reached: `<A> applied / <U> unresolved`. `<A>` = applied total; `<U>` = unapplied valid/partially-valid at termination.
  - Numeric values stay literal; the surrounding words (`applied`, `fix(es) applied`, `residual`, `unresolved`) translate.
- **Trend segment** — `trend: <trend_keyword>`. Both the label and the keyword translate.

**Trend keyword pre-computation** (runs before the headline renders; the Trend sentence in §Step 19 — Review assessment reuses this keyword):

Trend is disposition-aware — a decrease driven by applied fixes differs from a decrease driven by user declines or out-of-diff skips. Inputs from `cycle_history`:

- `C[i]` = `cycle_history[i].selectable_count` for `i` in `1..M`.
- `R_final` = residual count at termination (`<R>` for Case A residuals, `<U>` for Case B, `0` for Case A clean).
- `M` = number of executed cycles.

Classify:

- `cascading` — `M >= 2` AND some `i` in `2..M` has `C[i] > C[i-1]`. Fixes introduced regressions, or codex surfaced progressively wider issues.
- `converging` — `R_final == 0` AND not `cascading`. Residuals cleared. Covers applied-fix convergence (`3 → 2 → 1`), single-cycle all-applied, and first-pass V=0 (no selectable findings, nothing deferred).
- `stable` — otherwise. Decline-driven disappearance (`R_final > 0`), flat counts, or any non-resolving trajectory.

Tie-break: `cascading` > `converging` > `stable`.

Golden cases:

| Trajectory | `M` | `C[i]` | `R_final` | Trend |
|-----------|-----|--------|-----------|-------|
| All applied, decreasing | 3 | 3 → 2 → 1 | 0 | `converging` |
| Single-cycle all applied | 1 | 3 | 0 | `converging` |
| First-pass V=0 | 1 | 0 | 0 | `converging` |
| Decline-driven drop | 3 | 1 → 1 → 0 (decline) | 1 | `stable` |
| Cycle-2 regression | 3 | 2 → 3 → 2 | 0 | `cascading` |
| Flat, no apply | 3 | 2 → 2 → 2 | 2 | `stable` |

## Verification Disclaimer

Fixed, variant-neutral boilerplate. The canonical text must hold under every termination variant — a body fitting only Clean termination would be false under Terminated with residuals and Cap reached, and readers stop treating it as a warning.

Render the canonical text verbatim (translated per `SKILL.md` §Language, no content substitution):

```
⚠️ <Verification-disclaimer heading translated>. <Disclaimer body translated: the skill never executes tests, lints, builds, or any verification command on behalf of the user. Reaching any termination variant (clean, with residuals, or at cap) means only that codex's finding sequence reached its stopping condition — it does NOT imply the code is correct, the diff is safe to ship, or the residual / unresolved findings listed above are immaterial. Before shipping, review the applied diff and run your own verification (test suite, type check, lint, build, manual smoke) as appropriate for the change.>
```

Prohibited inside the disclaimer:

- Run-specific manual-test scenarios (e.g. "consider manual smoke testing against …").
- Build / test / lint result claims from the current run.
- Next-step suggestions, user-facing commands, or scope-specific hints.
- Variant-specific framing (`"resolved" claim`, `all findings resolved`, `no residuals were carried`, `cap reached`) — the body must remain true for all three variants.
- Substitution of the generic parenthetical `(test suite, type check, lint, build, manual smoke)`.

Run-specific recommendations go to §Step 19 — Review assessment's Suggested next action. Every termination variant renders the full disclaimer; do not compress a later rendering to a `see Case A for rationale` stub.

## Applied-Fixes List

An index of applied findings across cycles, not a re-summary. The codex title is already visible in each cycle's Summary block; this list enumerates which findings went Summary → applied.

Format, one outer bullet per cycle in order 1 → 2 → 3:

- Cycle with ≥1 applied fixes — `<Cycle label translated> <N>:`, followed by one sub-bullet per applied fix:
  - `F<n> (<scope_category>) <codex title verbatim>`
  - `F<n>` — cycle-local ID from that cycle's Summary block. Read from `cycle_history[N].applied_fixes[*].display_id`. Do not reconstruct or renumber. The `F` prefix stays literal.
  - `<scope_category>` — verbatim; always `must-fix` or `minimal-hygiene` (applied fixes come from these two only).
  - `<codex title verbatim>` — the codex `title` field, emitted in the post-overlay redacted form per `review-scope-guard` SKILL.md §Secret Hygiene. The verbatim contract is preserved within the redacted form (see scope-guard §Verbatim contract precedence); never paraphrased, shortened, or translated outside the redaction substitution.
- Cycle with 0 applied fixes — `<Cycle label translated> <N>: <no-fix label translated>` (canonical English: `none`).

Prohibited inside the list:

- Implementation prose (e.g. `added BaseName to CachedIdentifier …`).
- Rationale (`because A-5's cache invalidation was weaker …`).
- Code snippets, identifiers, diff excerpts.
- `to fix X` / `because Y` / `the fix …` expansions.

Implementation detail lives in `git log`; run-specific guidance lives in §Step 19 — Review assessment's Suggested next action.

## Step 19 — Review assessment

After printing Case A or Case B output, render a concise review assessment block **in the user's language** (per `SKILL.md` §Language) to help the user decide whether to re-invoke the skill or move on:

```
## Review assessment

**Trend**: <1 sentence that leads with the trend_keyword classified in §Verdict Headline — e.g. "converging (5 → 4 → 3, severity shift from high to medium)", "stable (structural gaps in each cycle)", "cascading (cycle N fixes created cycle N+1 findings)". The leading keyword MUST match the headline's trend_keyword; the parenthetical evidence is the additional detail this sentence adds over the headline.>

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

## Step 20 — Soft-reset temporary cycle commits

(`branch` / `base-ref` only). During the review run, one commit per cycle was created — either by the user under `SKILL.md` Phase 1 step 14's manual-commit pause, or by Claude under step 14's auto-commit branch when `auto_commit_consent == true` (the consent path is run-scoped; see SKILL.md step 14 §Auto-commit consent). Both paths produce identical commit shapes (`git add -- <touched files>` + `git commit -m "review cycle <N> fixes"`) on the same `pre_pause_head` anchor, so the soft-reset behavior below is path-agnostic. These are intermediate review-cycle artifacts, not the user's intended final commit. To keep the applied code changes while removing the intermediate commit history:

- If `review_target.scope == working-tree` or no cycle commits were created, skip this step silently. "Silently" means **produce zero output for this step** — do NOT print `Soft-reset step skipped`, `Soft-reset skipped (scope == working-tree)`, a `(skipped)` tag, or any other acknowledgment that the step existed. The surrounding termination output must flow from §Step 19 — Review assessment directly to the end of the skill with no trace of this step. Silent-skip applies only to the scope / no-cycle-commits preconditions above; the Terminal-cycle verification warning, the Dirty-state audit abort, and the Soft-reset preview gate below remain user-visible in their own triggering cases.
- **Terminal-cycle verification**: before resetting, verify the final cycle's applied fixes were actually committed. Run `git status --porcelain -- <final cycle's touched_files>`. If any files have uncommitted changes, print `⚠️ Final cycle has uncommitted applied fixes (<file list>). Soft-reset will NOT stage these — only committed changes become staged after reset. Commit them first, or they will be lost from the staged state.` and skip the reset with a manual-squash fallback: `git reset --soft <pre_cycle_1_head>`.
- Retrieve `pre_cycle_1_head` from `SKILL.md` Phase 0 step 7 and record the current `HEAD` as `final_head`.
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
