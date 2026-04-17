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

`ACTIVE` means the threshold is met. `ADVISORY` means the lower threshold is met but the hard warning threshold is not. `WARNING` means the hard threshold is met. Include an explicit `ACTIVE` / `ADVISORY` / `WARNING` label on every row so the user can scan severity.

## Recommendation Phrasing

When at least one signal is `ACTIVE` or `WARNING`, print a final one-line recommendation after the table: `Recommended: stop the review loop and ship / audit scope before the next cycle.` Do not print a recommendation when only `ADVISORY` signals are active — those are informational.

The recommendation is advisory. Claude never stops the caller's cycle on its own.
