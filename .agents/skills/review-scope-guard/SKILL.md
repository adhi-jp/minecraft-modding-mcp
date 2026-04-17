---
version: 1.0.0
name: review-scope-guard
description: Triage code/plan review findings against an explicit Definition of Done so must-fix bugs are separated from scope creep, out-of-scope semantic implementations, and noise. Collects the six-item Definition of Done interactively on first invocation, classifies every finding into one of four categories (`must-fix`, `minimal-hygiene`, `reject-out-of-scope`, `reject-noise`), maintains a rejected-findings ledger so repeated complaints are not re-litigated across cycles, and evaluates five stop signals for scope drift. Output is a triage verdict table plus an updated ledger usable by `codex-review-cycle`. Use when a codex review returned findings that may drift beyond the stated scope, when the user explicitly asks to triage or scope-check review findings, or when invoked by `codex-review-cycle` between its validity check and summary render. Do NOT trigger for single-shot lint reviews, unrelated code changes, or when the user has not yet run a review.
---

# Review Scope Guard

## Overview

A scope-aware triage skill that sits between a review tool and a user-facing summary. It takes a list of review findings and a Definition of Done (DoD), classifies each finding into one of four action categories, and maintains a rejected-findings ledger so the same complaint is never re-litigated across cycles. The skill never applies fixes itself — it only decides which findings are worth escalating and which should be suppressed.

This skill exists because adversarial review tools (including codex's `adversarial-review`) are calibrated for "correctness gaps from a theoretical ideal", not "impact on the stated scope". Without a scope filter the implementer chases edge cases and semantic implementations that were never in scope, then reverts them. A 19-cycle curl-import session that reverted ~50% of its Phase 2-3 additions is the empirical baseline this skill is designed to prevent.

## When to Use

Use this skill when:

- The user explicitly asks to triage, scope-check, or filter review findings against an acceptance bar.
- A codex review (native or adversarial) returned findings that you suspect drift beyond the stated scope.
- `codex-review-cycle` invokes this skill from its Phase 1 workflow (between the validity check and the summary render).

Do NOT use this skill when:

- The user wants a single-shot lint cleanup — no DoD is needed for a single-pass suggestion list.
- No review has been run yet — there are no findings to triage. Run the review first.
- The change is so small the DoD is obvious from the diff itself.

## Inputs

- **`findings[]`** (required) — the list of review findings to triage. Each entry must have at least `id`, `title`, `recommendation`. Preferred shape (from codex `adversarial-review --json`): `{id, severity, file, line_start, title, recommendation, body}`.
- **`dod`** (optional) — a pre-loaded Definition of Done as either structured text or a file path. If absent, the skill collects it interactively in Phase 0.
- **`rejected_ledger`** (optional) — a prior ledger from earlier cycles. If absent, starts from empty.
- **`metrics`** (optional, used by stop signals) — per-target `size_initial` / `size_now` line counts, `tests_total`, `required_features_count`. Missing metrics mean the corresponding stop signals report `not evaluated`.
- **`history`** (optional) — per-cycle list of applied finding IDs with their triage categories. Needed for `hygiene-only-stretch` and `out-of-scope-streak`.

## Outputs

- **Triage verdict table** — one row per input finding with category, rationale, DoD anchor, and recommended action. Every finding is represented, including `reject-*` ones (for audit trail).
- **Updated rejected ledger** — YAML-style structure carrying fingerprint, title, file, category, reason, first/last cycle seen, and count.
- **Active stop signals** — only the signals that tripped this cycle, with evidence.
- **Next-action hint** — one-line recommendation when any stop signal is `ACTIVE` or `WARNING`.

## Workflow

### Phase 0 — DoD Resolution

1. **Check for pre-loaded DoD.** If the caller passed a DoD object or file path, read it and skip to step 3. Otherwise run step 2.
2. **Interview the user.** Collect the six DoD items in order via `AskUserQuestion`, one question per item. See `references/dod-template.md` for the question wording and expected answer shapes:
   1. Intent (one sentence)
   2. Supported inputs
   3. Required features
   4. **Explicit out-of-scope** (most important for triage)
   5. Quality bars
   6. Accepted divergences
   If the user declines an item, record `(not specified)` and continue. Warn once if ≥2 items are blank.
3. **Echo the DoD.** Print the collected DoD back as a numbered markdown list so the user can confirm it before triage runs. Do not persist to disk unless the user explicitly asks.

### Phase 1 — Findings Normalization

4. **Ingest findings.** Accept the `findings[]` input. If IDs are absent, assign `F1..Fn`. Preserve codex's original `title` and `recommendation` fields verbatim — the triage output must not paraphrase.
5. **Load the prior ledger.** If the caller passed a `rejected_ledger`, load it. Compute the ledger's fingerprint set once so Phase 2 can do O(1) lookups.
6. **Compute fingerprints for this cycle's findings.** Fingerprint key: `<severity>|<normalized_title>|<file>`. Normalize `title` by lowercasing and collapsing whitespace. The fingerprint is the sole yo-yo detection key.

### Phase 2 — Triage

7. **Classify each finding** using the decision order in `references/triage-categories.md`:
   1. **must-fix / security check** — if the finding violates a DoD required feature, quality bar, or security property, classify as `must-fix`. This runs **first** so a ledger hit can never permanently suppress a security- or DoD-relevant finding whose context has since changed.
   2. **Ledger lookup** — if the fingerprint matches an entry in the ledger AND step 1 did not fire, classify as `reject-noise: already-rejected` and reuse the ledger's prior reason verbatim.
   3. **out-of-scope check** — if the finding targets a DoD explicit out-of-scope item or proposes functionality not in DoD required features, classify as `reject-out-of-scope`.
   4. **noise check** — if the finding is a vague suggestion, a niche edge case, or (on plan targets) a detailed-design nitpick, classify as `reject-noise`.
   5. **fall-through** — if none of the above matched, default to `minimal-hygiene`. This is the right default for "a real hygiene problem on an out-of-scope flag that still needs a 1-line consume + warn". When `dod` is `null` (user declined the interview), the fall-through still lands in `minimal-hygiene` — the skill preserves the 4-category invariant (see §Category Invariant) — but the summary footer adds the degraded-mode warning described in `codex-review-cycle` failure modes.

**Category Invariant**: the triage system has exactly **4 categories** (`must-fix`, `minimal-hygiene`, `reject-out-of-scope`, `reject-noise`). Adding a 5th category (e.g. `unclassified`) is a Required Feature violation — future callers or self-review iterations MUST reject any such proposal as `reject-out-of-scope`. Degraded-mode handling (missing DoD) stays inside the 4 categories via the `minimal-hygiene` fall-through plus a warning; it does not create a new bucket.
8. **Record rationale per finding.** Write a short `rationale` (≤30 words), a `dod_anchor` (which DoD item supports the decision, or `"none"`), and a `recommended_action` (`Apply fix` / `Apply 1-line hygiene` / `Reject (ledger forward)` / `Reject (noise)`).

### Phase 3 — Ledger Update

9. **Update the ledger.** Add or increment entries for every finding classified as `reject-out-of-scope` or `reject-noise`:
   - New fingerprint → append a new entry with `first_seen_cycle = current`, `last_seen_cycle = current`, `count = 1`.
   - Existing fingerprint → increment `count`, set `last_seen_cycle = current`, leave `first_seen_cycle` unchanged. Preserve the original `reason`; do not overwrite with the new cycle's rationale unless the user explicitly asks (this keeps the history stable).
   - Findings classified `must-fix` or `minimal-hygiene` do NOT enter the ledger — they are about to be applied, not rejected.
10. **Emit the updated ledger** in the format described in §Rejected Ledger Format.

### Phase 4 — Stop Signal Evaluation

11. **Evaluate the five stop signals** using `references/stop-signals.md`. Each signal returns `ACTIVE`, `ADVISORY`, `WARNING`, `silent`, or `not evaluated: metrics missing`.
12. **Render the signal table.** Print only tripped signals. Print `not evaluated` signals under a separate footnote so the user knows they were considered.
13. **Emit the next-action hint.** If any signal is `ACTIVE` or `WARNING`, print `Recommended: stop the review loop and ship / audit scope before the next cycle.` No hint for `ADVISORY`-only runs.

### Phase 5 — Output

14. **Render the triage verdict table** in the format in §Output Template. Every input finding appears in the table. Titles and recommendations are verbatim from codex.
15. **Hand control back to the caller.** If invoked by `codex-review-cycle`, return the triage verdict table, updated ledger, and active signals. If invoked standalone, print everything to the user and stop.

## 4 Triage Categories (summary)

Full definitions and curl-retrospective examples in `references/triage-categories.md`.

| Category | Contains | Action |
|----------|----------|--------|
| `must-fix` | Core feature bug, round-trip bug, security-relevant, URL/state hygiene, regression of existing behavior — anything violating a DoD required feature or quality bar | Apply fix this cycle |
| `minimal-hygiene` | Out-of-scope flag/feature whose value pollutes a core path. Apply minimal 1-line consume + warn only | Apply 1-line hygiene only; semantics NOT implemented |
| `reject-out-of-scope` | Semantic implementation of DoD-excluded features, or new-feature proposals not in DoD required features | Reject; add to ledger for next-cycle forward |
| `reject-noise` | Vague suggestions, niche edge cases, repeated complaints (ledger hit), detailed-design on plan targets | Reject; add to or increment ledger |

**Decision order**: must-fix/security → ledger lookup (for non-must-fix only) → out-of-scope → noise → fall-through to `minimal-hygiene`. must-fix/security runs first so a ledger hit never silently suppresses a finding that has become security-relevant or DoD-required since the original rejection.

## DoD Template (summary)

Six items collected in Phase 0; full question wording in `references/dod-template.md`:

1. **Intent** — one-sentence change goal.
2. **Supported Inputs** — concrete input sources the change must handle.
3. **Required Features** — must-have flags / endpoints / behaviors.
4. **Explicit Out-of-Scope** — tempting extensions explicitly ruled out. Most important item for triage.
5. **Quality Bars** — non-negotiable properties (e.g. wire-byte preservation, no silent TLS downgrade).
6. **Accepted Divergences** — losses the user is willing to ship.

DoD lives in-session only. The skill does not write it to disk.

## Rejected Ledger Format

```yaml
rejected_findings_ledger:
  - id: L1
    fingerprint: "<severity>|<normalized_title>|<file>"
    title: "<finding title verbatim>"
    file: "<path or null>"
    category: "reject-out-of-scope"
    reason: "out-of-scope: --digest --basic last-wins is cURL 7.82+ niche; DoD explicit out-of-scope"
    first_seen_cycle: 1
    last_seen_cycle: 3
    count: 3
  - id: L2
    fingerprint: "<severity>|<normalized_title>|<file>"
    title: "<another title verbatim>"
    file: "<path or null>"
    category: "reject-noise"
    reason: "niche edge case: mixed --data-urlencode + trailing = bytes; no typical user impact"
    first_seen_cycle: 2
    last_seen_cycle: 2
    count: 1
```

- `fingerprint` — `<severity>|<normalized_title>|<file>`. Used for O(1) re-detection.
- `title` — codex verbatim. Never paraphrase.
- `reason` — the rationale assigned at first triage. Stable across re-occurrences so history stays coherent.
- Projecting into `codex-review-cycle`'s `<rejected_findings>` block:
  ```xml
  <rejected cycle="N-1" reason="<reason>"><![CDATA[<title>]]></rejected>
  ```

## Stop Signals (summary)

| Signal | Threshold | Meaning | Evaluable via `codex-review-cycle`? |
|--------|-----------|---------|-------------------------------------|
| `hygiene-only-stretch` | 2 consecutive cycles applied only `minimal-hygiene` | Diminishing returns | ✅ yes — caller passes `cycle_history.applied_fixes[]` with categories |
| `repeat-finding` | Any ledger entry `count >= 2` | Yo-yo is forming | ✅ yes — caller passes `rejected_ledger` |
| `out-of-scope-streak` | 3 consecutive cycles with ≥80% applied fixes on out-of-scope areas | Clear scope drift | ⚠️ **partial** — caller's `applied_fixes[]` only tags scope category, not out-of-scope area attribution. In the integrated workflow this signal reports `not evaluated: DoD-anchor attribution missing` unless the caller is extended to record it |
| `file-bloat` | Target file(s) grew ≥1.5× (advisory) or ≥2× (warning) from baseline | Over-engineering likely | ❌ **no** — `codex-review-cycle` does not capture `size_initial` at Phase 0 or `size_now` per cycle. In the integrated workflow this signal always reports `not evaluated: metrics missing`. It is only usable when `review-scope-guard` is invoked standalone with explicit metrics |
| `reactive-testing` | `tests_total / required_features >= 5` | Tests growing faster than features | ❌ **no** — `codex-review-cycle` does not capture `tests_total` or `required_features` count. Same caveat as `file-bloat`: standalone-only |

All signals are **hints only**. The skill never stops the caller's review loop. Full conditions and required inputs in `references/stop-signals.md`.

**Integration caveat**: when invoked from `codex-review-cycle`, two of the five signals (`file-bloat`, `reactive-testing`) and part of a third (`out-of-scope-streak`) are structurally `not evaluated` because the caller does not currently collect the required metrics. This is a deliberate simplicity trade-off in `codex-review-cycle` — it keeps the caller's Phase 0 light. Users who need the full five-signal surface should invoke `review-scope-guard` standalone after any review tool and pass `metrics` and `history` with the required attribution explicitly.

## Output Template

```markdown
### Scope triage (cycle N, DoD anchor: <intent sentence>)

| ID | Severity | File:Line            | Title (verbatim)                | Category             | DoD anchor        | Rationale                                    | Action                     |
|----|----------|----------------------|---------------------------------|----------------------|-------------------|----------------------------------------------|----------------------------|
| F1 | high     | src/auth/login.ts:42 | Missing null check on userId    | must-fix             | Required features | Core-path correctness violation              | Apply fix                  |
| F2 | medium   | src/api/user.ts:88   | Consider adding retry logic     | reject-noise         | none              | Vague: no concrete failure mode              | Reject (noise)             |
| F3 | low      | docs/plan.md:15      | Rename process to handler       | reject-noise         | none              | Detailed-design on plan target               | Reject (noise)             |
| F4 | medium   | src/curl.rs:120      | Implement --json shorthand body | reject-out-of-scope  | Out-of-scope      | cURL 7.82+ semantics explicitly excluded     | Reject (ledger forward)    |
| F5 | medium   | src/curl.rs:130      | --url-query value leaks into URL| minimal-hygiene      | Quality bars      | Value-consume + warn; semantics NOT added    | Apply 1-line hygiene       |

### Rejected ledger after this cycle

<YAML block>

### Active stop signals (cycle N)

| Signal | Status | Evidence |
|--------|--------|----------|
| ...    | ...    | ...      |

_Not evaluated (metrics missing): <list>_

**Next-action hint**: <recommendation when ACTIVE/WARNING, else omit>
```

Format rules that protect finding intent:

- `Title (verbatim)` column must be the codex `title` field exactly.
- The DoD anchor column names which DoD item supports the classification, not Claude's interpretation of what the finding "really means".
- Even `reject-*` rows print the original title verbatim so the user can audit and override.
- Long recommendations quoted from codex go under the table in a per-finding verbatim block, the same way `codex-review-cycle` surfaces them.

## Integration with codex-review-cycle

When `codex-review-cycle` calls this skill in its Phase 1:

1. `codex-review-cycle` calls `review-scope-guard` at its step 10a (after the silent validity check at step 10, before the summary render at step 11).
2. The caller passes `findings[]`, the running `rejected_ledger`, optional `metrics`, and optional `history`. For adversarial-review variant, the caller pre-collects DoD at step 7 of Phase 0 and passes it forward. For native-review variant, the first cycle of the run collects DoD here via Phase 0; later cycles reuse the cached DoD.
3. This skill returns the triage verdict table, updated ledger, and active stop signals.
4. `codex-review-cycle` merges the triage categories into its summary table as a new `Scope` column, filters its user-selection UI to only `must-fix` and `minimal-hygiene`, and forwards the ledger into the next cycle's `<review_context>` `<rejected_findings>` block.
5. Stop signals appear in the `codex-review-cycle` summary footer.

The skill is equally callable standalone: the user runs `review-scope-guard` after any review tool and passes the findings via conversation.

## Failure Modes

- **User declines all DoD questions** — warn once, proceed with `(not specified)` values. Triage still runs; `reject-out-of-scope` decisions degrade to best-effort because there is no explicit out-of-scope list to match. The verdict table notes `DoD anchor: none (DoD not collected)` on every row.
- **Empty `findings[]`** — emit an empty verdict table and `No findings to triage.`, preserve any prior ledger unchanged, and exit.
- **Malformed finding (missing `title`)** — skip the finding, log `F<n>: dropped (missing title)` in the output, and continue with the remainder.
- **Ledger fingerprint collision (two different titles normalized to the same key)** — treat the second occurrence as a distinct entry with a disambiguating suffix appended to the fingerprint. Do not merge silently.
- **Metrics partially supplied** — evaluate the signals whose inputs are present; mark the others `not evaluated: metrics missing`. Never fabricate missing metrics.

## References

- `references/dod-template.md` — the six-item Definition of Done interview.
- `references/triage-categories.md` — full definitions of the four categories with curl-retrospective examples.
- `references/stop-signals.md` — the five stop signals, thresholds, required inputs, and output format.
