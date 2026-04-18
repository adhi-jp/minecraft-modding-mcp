# Stop Signals

Five heuristics that indicate a review loop is spending more cycles than it is gaining. The signals are **hints only** — they never force the loop to stop. The user sees them in the output and decides whether to keep iterating.

## Why hints, not hard stops

The calling skill (typically codex-review-cycle) owns the cycle cap. Stop signals surface information the cap cannot: a cycle can still be under cap but already out of useful findings. The signal table is the data the user needs to make that call informedly.

Each signal has a `condition`, a `threshold`, an `interpretation`, and a `required inputs` list. If the required inputs are missing, the signal reports `not evaluated: metrics missing` rather than flipping to a default.

## The Five Signals

### 1. `hygiene-only-stretch`

**Condition**: in the last 2 review cycles, every applied finding was classified `minimal-hygiene`.

**Threshold**: exactly 2 consecutive cycles with `applied_fixes` ⊂ `minimal-hygiene` and at least 1 applied fix in each.

**Required inputs**: per-cycle history of applied findings with their triage categories.

**Interpretation**: the review is no longer producing high-value `must-fix` bugs. The next cycle is likely to produce more hygiene-only findings or pure noise. Recommended action: stop and ship.

### 2. `repeat-finding`

**Condition**: at least one fingerprint in the current cycle's findings matches an entry already in the rejected ledger, **regardless** of whether the new occurrence is classified `reject-noise: already-rejected`.

**Threshold**: `count >= 2` on any ledger entry after this cycle's update.

**Required inputs**: the rejected ledger (maintained by Phase 3 of the skill).

**Interpretation**: codex is not incorporating the rejection context — either the context block is not being forwarded correctly, or codex insists on re-surfacing the same concern from a slightly different angle. Either way, the next cycle's discussion will rehash old ground. Recommended action: stop, or escalate the rejection rationale in the next cycle's `<review_context>`.

### 3. `out-of-scope-streak`

**Condition**: in the last 3 review cycles, every applied finding was caused by an out-of-scope flag or feature (even if the applied fix was `minimal-hygiene`).

**Threshold**: exactly 3 consecutive cycles where ≥80% of applied fixes touched out-of-scope areas.

**Required inputs**: per-cycle history of applied findings with their DoD anchor (in-scope / out-of-scope area attribution).

**Interpretation**: the review is drifting into an out-of-scope neighborhood. Even when individual fixes are hygiene-only, clustering around out-of-scope code is a signal that the reviewer is pattern-matching on the wrong surface. Recommended action: stop and audit the DoD — the neighborhood may need an explicit "we're not touching this at all" line.

### 4. `file-bloat`

**Condition**: the target file(s) grew beyond a multiplier of the pre-cycle baseline line count.

**Threshold**:
- `advisory` at `size_now / size_initial >= 1.5`
- `warning` at `size_now / size_initial >= 2.0`

**Required inputs**: `size_initial` (line count captured at Phase 0 for each target file) and `size_now` (current line count).

**Interpretation**: growth beyond 1.5× in a review-and-fix loop is almost always scope creep or over-engineering, not necessary correctness. 2× is a hard advisory to split files and re-audit scope. Recommended action: pause before the next cycle; module-split if the target is a single large file, and re-read the DoD explicit out-of-scope list.

### 5. `reactive-testing`

**Condition**: the ratio of total test count to DoD required-feature count has exceeded a threshold.

**Threshold**: `tests_total / required_features >= 5`.

**Required inputs**: `tests_total` (count of tests in the test surface for the change area) and `required_features` (count of DoD items 3 entries).

**Interpretation**: tests are growing faster than features, which usually means tests are being added to prevent regression of each review finding individually instead of to prove the acceptance criteria. Reactive testing inflates the regression suite without improving confidence in the DoD-level properties. Recommended action: stop adding regression tests; write acceptance tests for the DoD required features first.

## Output Format

After Phase 4 evaluation, emit a table of active signals only. Silent signals (not tripped) are not printed. `not evaluated` signals are printed under a separate footnote so the user knows they were considered.

```markdown
### Active stop signals (cycle N)

| Signal                | Status      | Evidence                                                     |
|-----------------------|-------------|--------------------------------------------------------------|
| hygiene-only-stretch  | ACTIVE      | cycles N-1, N applied only `minimal-hygiene` findings        |
| file-bloat            | ADVISORY    | src/curl_import.rs: 1500 → 2310 lines (1.54× baseline)       |

_Not evaluated (metrics missing): reactive-testing_
```

### Per-cycle suppression for `not evaluated` rows

When invoked across multiple cycles (e.g. from `codex-review-cycle`), the caller can suppress the `not evaluated` footnote on cycle 2+ only when the set is **exactly identical to the immediately previous cycle (N-1)**. Comparing against cycle 1 alone would hide flapping (cycle 1: `{A}` → cycle 2: `{A,B}` → cycle 3: `{A}` prints "unchanged from cycle 1" while silently masking the cycle-2 divergence). To make this comparison deterministic, the skill emits `not_evaluated_signal_names` as part of its per-cycle return value (populated in Phase 4 step 11 below).

**Return-value schema addition (Phase 4 step 11)**: alongside the signal table, return `not_evaluated_signal_names: string[]` — the ordered list of signal names currently in `not evaluated: metrics missing` status, filtered through the 5-signal canonical order (`hygiene-only-stretch`, `repeat-finding`, `out-of-scope-streak`, `file-bloat`, `reactive-testing`). Order is NEVER reshuffled: the canonical order is the sort key.

**Comparison semantics (caller side)**: the caller stores each cycle's `not_evaluated_signal_names` on its own `cycle_history[N]`. Cycle N's list equals cycle N-1's list iff (a) same length, AND (b) element-wise equal under `===` string comparison in index order. Any difference — element added, removed, or reordered (reordering should never happen given the canonical order, but guard against it anyway) — counts as "changed" and re-renders the full footnote.

**Caller rendering rule**: on cycle 1, render the full footnote (or the standalone-compact one-liner when applicable). On cycle N ≥ 2, if the cycle N-1 comparison above holds, replace the footnote with:

```
_Not evaluated: unchanged from cycle N-1 — see cycle N-1 summary for signal list._
```

If the set differs from cycle N-1, re-render the full footnote AND include a one-line delta note: `_Not evaluated delta vs cycle N-1: added=<names>, removed=<names>._`. Callers that invoke this skill standalone (single-shot) always see the full footnote because there is no prior cycle.

`ACTIVE` means the threshold is met. `ADVISORY` means the lower threshold is met but the hard warning threshold is not. `WARNING` means the hard threshold is met. Include an explicit `ACTIVE` / `ADVISORY` / `WARNING` label on every row so the user can scan severity.

### Structurally-unevaluable signals

When invoked from `codex-review-cycle`, two of the five signals (`file-bloat`, `reactive-testing`) and part of a third (`out-of-scope-streak` without DoD-anchor attribution) are **structurally unevaluable** — the caller does not collect the required metrics by design. These signals SHOULD be hidden from the per-cycle footer entirely (not even listed as "not evaluated") because their presence is deterministic and adds no actionable information. The caller instead renders a single note in the run's first cycle footer:

```
_Stop signals unavailable in codex-review-cycle integration: file-bloat, reactive-testing (standalone invocation required for full 5-signal surface)._
```

From cycle 2 onwards the note is omitted. Standalone callers that pass `metrics` and `history` explicitly still see the full footnote.

## Recommendation Phrasing

When at least one signal is `ACTIVE` or `WARNING`, print a final one-line recommendation after the table: `Recommended: stop the review loop and ship / audit scope before the next cycle.` Do not print a recommendation when only `ADVISORY` signals are active — those are informational.

The recommendation is advisory. Claude never stops the caller's cycle on its own.
