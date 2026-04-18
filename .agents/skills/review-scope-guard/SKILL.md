---
version: 1.1.0
name: review-scope-guard
description: Triage code/plan review findings against an explicit Definition of Done so must-fix bugs are separated from scope creep, out-of-scope semantic implementations, and noise. Collects the six-item Definition of Done interactively on first invocation, classifies every finding into one of four categories (`must-fix`, `minimal-hygiene`, `reject-out-of-scope`, `reject-noise`), maintains a rejected-findings ledger so repeated complaints are not re-litigated across cycles, and evaluates five stop signals for scope drift. Output is a triage verdict table plus an updated ledger usable by `codex-review-cycle`. Use when a codex review returned findings that may drift beyond the stated scope, when the user explicitly asks to triage or scope-check review findings, or when invoked by `codex-review-cycle` between its validity check and summary render. Do NOT trigger for single-shot lint reviews, unrelated code changes, or when the user has not yet run a review.
---

# Review Scope Guard

## Overview

A scope-aware triage skill that sits between a review tool and a user-facing summary. It takes a list of review findings and a Definition of Done (DoD), classifies each finding into one of four action categories, and maintains a rejected-findings ledger so the same complaint is never re-litigated across cycles. The skill never applies fixes itself — it only decides which findings are worth escalating and which should be suppressed.

This skill exists because adversarial review tools (including codex's `adversarial-review`) are calibrated for "correctness gaps from a theoretical ideal", not "impact on the stated scope". Without a scope filter the implementer chases edge cases and semantic implementations that were never in scope, then reverts them. A 19-cycle curl-import session that reverted ~50% of its Phase 2-3 additions is the empirical baseline this skill is designed to prevent.

## Language

All user-facing output is rendered in the user's language (the language the user has been using in the conversation, or as configured in the Claude Code system-level language setting). This section is the **authoritative translation contract** — any per-language sample reference (e.g. `references/output-samples.ja.md`) is illustrative only and MUST NOT contradict these rules.

**Translate into the user's language:**

- Section headings and column labels (`カテゴリ` / `判定理由` / `アクション` equivalents in the target language)
- Free-text fields Claude authors: `rationale` body, `recommended_action` values, stop-signal evidence prose, next-action hints, degraded-mode warnings
- `AskUserQuestion` `question`, `header`, and option `label` / `description` fields (e.g. during DoD interview)

**Keep verbatim (do NOT translate), regardless of user language:**

- Codex `title` field (surfaced in the `Title (verbatim)` column)
- Codex `recommendation` field (quoted per-finding below the triage table)
- Severity values (`high` / `medium` / `low`) — codex output
- Category names (`must-fix` / `minimal-hygiene` / `reject-out-of-scope` / `reject-noise`)
- Stop-signal names (`hygiene-only-stretch` / `repeat-finding` / `out-of-scope-streak` / `file-bloat` / `reactive-testing`) and `Status` keywords (`ACTIVE` / `ADVISORY` / `WARNING` / `silent`)
- DoD anchor fixed labels (`Required features` / `Out-of-scope` / `Quality bars` / `Supported inputs` / `Accepted divergences` / `none`)
- Technical identifiers: file paths, `fingerprint`, `cluster_id`, field names like `first_seen_cycle`, `last_seen_cycle`, `count`, `not_evaluated_signal_names`
- Cycle indices (`cycle N`)

For a Japanese rendering example that applies these rules, see `references/output-samples.ja.md`. For German, Korean, or other languages, apply the same rules directly — the Japanese sample is an illustration, not a template to translate.

## When to Use

Use this skill when:

- The user explicitly asks to triage, scope-check, or filter review findings against an acceptance bar.
- A codex review (native or adversarial) returned findings that you suspect drift beyond the stated scope.
- `codex-review-cycle` invokes this skill from its Phase 1 workflow (between the validity check and the summary render).

Do NOT use this skill when:

- The user wants a single-shot lint cleanup — no DoD is needed for a single-pass suggestion list.
- No review has been run yet — there are no findings to triage. Run the review first.
- The change is so small the DoD is obvious from the diff itself.

If `review-scope-guard` is not registered with the harness (Skill() invocation fails), run its workflow manually by reading this SKILL.md.

## Inputs

- **`findings[]`** (required) — the list of review findings to triage. Each entry must have at least `id`, `title`, `recommendation`. Preferred shape (from codex `adversarial-review --json`): `{id, severity, file, line_start, title, recommendation, body}`.
- **`dod`** (optional) — a pre-loaded Definition of Done as either structured text or a file path. If absent, the skill collects it interactively in Phase 0.
- **`rejected_ledger`** (optional) — a prior ledger from earlier cycles. If absent, starts from empty.
- **`metrics`** (optional, used by stop signals) — per-target `size_initial` / `size_now` line counts, `tests_total`, `required_features_count`. Missing metrics mean the corresponding stop signals report `not evaluated`.
- **`history`** (optional) — per-cycle list of applied finding IDs with their triage categories. Needed for `hygiene-only-stretch` and `out-of-scope-streak`.
- **`review_target`** (optional overall, **required when DoD is collected in `proposal` mode**) — the caller's resolved review target, shaped as `{scope, base_ref, base_sha, diff_command, diff_files, diff_numstat, commit_range, commit_messages[], diff_patch_excerpts}`. `scope` ∈ `working-tree|branch|base-ref`; `base_sha` is the frozen SHA (`base_ref` is display-only); `diff_files` is `git diff --name-only` output; `commit_messages[]` is the subject+body list of commits in the range (empty for working-tree); `diff_patch_excerpts` is bounded content-bearing evidence (first ~200 lines of tracked-modified diff + first ~50 lines of each untracked file for working-tree; **also populated for branch/base-ref when commit messages are templated/vague** — see proposal-mode evidence gate below). Without `review_target`, `proposal` mode is disabled and the skill falls back to `interview` mode for all six DoD items — proposal mode MUST NOT draft from ambient git state, because drafting from the wrong scope would make the scope classifier circular (DoD derived from the diff then used to judge the diff). **Proposal-mode evidence gate**: proposal mode requires content-bearing evidence regardless of scope:
  - **Working-tree**: requires non-empty `diff_patch_excerpts`; filename+numstat alone is insufficient. If commit_messages is empty AND diff_patch_excerpts is empty/blank, fall back to interview.
  - **Branch / base-ref**: commit messages alone are not automatically sufficient. At least one commit must have a subject of ≥20 characters AND a non-empty body, OR `diff_patch_excerpts` must be populated (same budget-based heuristic as working-tree). If all commits are short/templated (e.g. `"fix review comments"`, `"wip"`, `"update tests"`) AND no patch excerpts are supplied, fall back to interview. A DoD drafted from a vague squash commit subject would anchor `must-fix` and `reject-out-of-scope` decisions for the whole run against a weak inferred scope — that is the failure mode this gate blocks.

## Outputs

- **Triage verdict table** — one row per input finding with category, rationale, DoD anchor, and recommended action. Every finding is represented, including `reject-*` ones (for audit trail).
- **Updated rejected ledger** — YAML-style structure carrying fingerprint, title, file, category, reason, first/last cycle seen, and count.
- **Active stop signals** — only the signals that tripped this cycle, with evidence.
- **`not_evaluated_signal_names`** — ordered `string[]` of stop-signal names whose status is `not evaluated: metrics missing`, in the 5-signal canonical order (see `references/stop-signals.md` §Per-cycle suppression). Callers persist this per cycle to decide whether to suppress repeated `not evaluated` footnotes in later cycles; standalone callers may ignore it.
- **`structurally_unevaluable_signal_names`** — ordered `string[]` of signals that are deterministically `not evaluated` for the current caller shape (e.g. `codex-review-cycle` always lacks `file-bloat` and `reactive-testing` metrics). Separate from `not_evaluated_signal_names` so callers can compact the footer: structurally-unevaluable signals are mentioned once per run (cycle 1), not per cycle. Standalone callers that supply metrics receive an empty list.
- **Next-action hint** — one-line recommendation when any stop signal is `ACTIVE` or `WARNING`.

## Workflow

### Phase 0 — DoD Resolution

1. **Check for pre-loaded DoD.** If the caller passed a DoD object or file path, read it and skip to step 2b (the item-4 completeness gate below) — **not** step 3. The gate MUST run for every DoD source (interactive interview, proposal mode, free-text paste, AND preloaded/cached DoD from a previous cycle). Otherwise caching across cycles would skip the gate on cycle 2+ and `reject-out-of-scope` classifications would run against an unvalidated item 4. Persist the gate result on the returned DoD object (e.g. `dod.item4_gate: "pass" | "degraded"`) so the caller can re-apply the degraded-mode footer every cycle without re-running the check when evidence is stable.
2. **Collect the six DoD items.** Four collection modes are available; see `references/dod-template.md` §Collection Modes for full descriptions and selection criteria. Brief summary:

   - **`interview`** — default. One `AskUserQuestion` per item. Safest for unfamiliar or large diffs.
   - **`proposal`** — Claude drafts all six from `review_target` evidence; user confirms. Gated on LOC threshold + evidence quality.
   - **`free-text`** — user pastes a pre-written DoD; Claude splits and confirms item 4.
   - **`quick`** — single `AskUserQuestion` for item 4 only; other items default to `(not specified)`. Trivial changes.

   If the user declines an item, record `(not specified)` and continue. Warn once if ≥2 items are blank. Regardless of mode, the step 2b item-4 completeness gate below runs against the final DoD. Proposal mode MUST NOT silently fill item 4 — if Claude cannot derive 3+ sibling-framed out-of-scope items from the diff alone, fall back to `interview` mode for item 4 only.

2b. **Item-4 completeness pre-triage gate (runs for every DoD source — interview/proposal/free-text/preloaded).** Because `reject-out-of-scope` decisions anchor directly on DoD item 4, an incomplete item 4 silently converts would-be rejections into `minimal-hygiene` fall-through. Count item 4's sibling-framed entries regardless of how the DoD was sourced:
   - If item 4 has **≥3 items AND each item names an `in-scope` sibling feature** (per `references/dod-template.md` §4 Strong requirement), the full triage pipeline runs normally.
   - Otherwise — item 4 is `(not specified)`, has <3 items, or any item lacks sibling framing — enter **reject-out-of-scope degraded mode** for this session: Phase 2 step 7 step-3 (out-of-scope check) is **disabled**; any finding that would have been `reject-out-of-scope` instead falls to the step-4 noise check (and then to `minimal-hygiene` if still unmatched). The summary footer MUST render `⚠️ DoD item 4 incomplete (<N> items, sibling-framing: <yes/no>) — reject-out-of-scope classifications are suppressed this session. Complete item 4 per dod-template.md §4 to restore the full scope guard.` on every cycle until item 4 is completed.
   - The degraded mode is deliberately loud rather than silent: the failure mode this skill exists to prevent is exactly "scope creep slipping through when the author did not think hard enough about out-of-scope boundaries". The footer text makes the gap visible to the user on every cycle.
   - **Override (intentional <3 items)**: if the user genuinely has <3 out-of-scope items and item 4's brevity is not an oversight (e.g. a tightly-scoped one-line bugfix), offer an explicit override. When the gate would fire degraded mode, first issue a single `AskUserQuestion` before enabling it:
     - `question`: "DoD item 4 has <N> sibling-framed items (<3 is the strong requirement). Is this intentional for a narrowly-scoped change, or would you like to add more?"
     - options:
       - `Intentional — accept <N> items, keep reject-out-of-scope active` — bypass degraded mode for this session. Store `dod.item4_gate: "override"` so later cycles do NOT re-prompt and the footer is suppressed. Record the user's rationale (free-text follow-up) in `dod.item4_override_reason`.
       - `Add more items now` — re-open interview mode for item 4 only; append the new items and re-run the gate.
       - `Enter degraded mode anyway` — proceed as previously specified (reject-out-of-scope disabled, footer warning every cycle). `dod.item4_gate: "degraded"`.
     The override path exists because "scope creep prevention" and "trivially-scoped change" are both legitimate states; the gate should distinguish them via user input, not silently punish the second case.
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

   **Cluster assignment**: when writing or incrementing a ledger entry, inspect the finding's `rationale` text for explicit phrases like "same root cause as L<n>", "same <concept> boundary", "same <subsystem> invariant". When such a phrase refers to an existing ledger entry, copy that entry's `cluster_id` to the new entry (creating the `cluster_id` on the referenced entry first if absent — use a kebab-case summary of the shared concept). Do not auto-cluster findings without an explicit rationale phrase: false clustering silently hides distinct concerns under a shared label.
10. **Emit the updated ledger** in the format described in §Rejected Ledger Format.

### Phase 4 — Stop Signal Evaluation

11. **Evaluate the five stop signals** using `references/stop-signals.md`. Each signal returns `ACTIVE`, `ADVISORY`, `WARNING`, `silent`, or `not evaluated: metrics missing`.

    After evaluating all five signals, construct `not_evaluated_signal_names: string[]` — the filtered list of signals whose status is `not evaluated: metrics missing`, in the canonical 5-signal order (`hygiene-only-stretch`, `repeat-finding`, `out-of-scope-streak`, `file-bloat`, `reactive-testing`). Attach this field to the skill's return value so the caller can suppress repeated footnotes on later cycles (see `references/stop-signals.md` §Per-cycle suppression).
12. **Render the signal table.** Print only tripped signals. Print `not evaluated` signals under a separate footnote so the user knows they were considered. When invoked across multiple cycles with an unchanged `not evaluated` set — compared by the comparison semantics in `references/stop-signals.md` §Per-cycle suppression — the caller replaces the footnote with the suppression line. This skill never renders the suppression line itself; it always produces the full footnote so standalone callers see complete output. The caller owns the decision.
13. **Emit the next-action hint.** If any signal is `ACTIVE` or `WARNING`, print `Recommended: stop the review loop and ship / audit scope before the next cycle.` No hint for `ADVISORY`-only runs.

### Phase 5 — Output

14. **Render the triage verdict table** in the format in §Output Template. Every input finding appears in the table. Titles and recommendations are verbatim from codex.
15. **Hand control back to the caller.** If invoked by `codex-review-cycle`, return the triage verdict table, updated ledger, active signals, and `not_evaluated_signal_names` (see §Outputs). If invoked standalone, print everything to the user and stop.

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
    cluster_id: "reqwest-jar-isolation"   # optional; shared across findings touching the same root cause
    title: "<finding title verbatim>"
    file: "<path or null>"
    category: "reject-out-of-scope"
    reason: "out-of-scope: --digest --basic last-wins is cURL 7.82+ niche; DoD explicit out-of-scope"
    first_seen_cycle: 1
    last_seen_cycle: 3
    count: 3
  - id: L2
    fingerprint: "<severity>|<normalized_title>|<file>"
    cluster_id: "reqwest-jar-isolation"
    title: "<another title verbatim>"
    file: "<path or null>"
    category: "reject-noise"
    reason: "niche edge case: mixed --data-urlencode + trailing = bytes; no typical user impact"
    first_seen_cycle: 2
    last_seen_cycle: 2
    count: 1
```

- `fingerprint` — `<severity>|<normalized_title>|<file>`. Used for O(1) re-detection.
- `cluster_id` — optional short kebab-case string grouping findings that share a root cause even when titles, files, or severities differ. Populated by Claude at Phase 2 classification time when the rationale explicitly names a shared concept (e.g. "same jar-isolation boundary as L1"). Leave unset when no shared cause is evident; never auto-generate to avoid false clustering. `cluster_id` never suppresses findings — it only groups them for the termination-time assessment in `codex-review-cycle` step 19.
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

- **User declines all DoD questions** — warn once, proceed with `(not specified)` values. Triage still runs; `reject-out-of-scope` decisions degrade to best-effort because there is no explicit out-of-scope list to match. The verdict table notes `DoD anchor: none (DoD not collected)` on every row. **Additionally**, the Phase 0 step 2 item-4 completeness gate fires: `reject-out-of-scope` classification is disabled this session and the summary footer renders the degraded-mode warning described there.
- **DoD item 4 has <3 items or lacks sibling framing** — same degraded mode as "user declines all DoD questions" above, but scoped to item 4 only (other DoD items may still anchor `must-fix` / quality-bar decisions). The footer warning explicitly names the item-4 shortfall so the user can fix it mid-session.
- **Empty `findings[]`** — emit an empty verdict table and `No findings to triage.`, preserve any prior ledger unchanged, and exit.
- **Malformed finding (missing `title`)** — skip the finding, log `F<n>: dropped (missing title)` in the output, and continue with the remainder.
- **Ledger fingerprint collision (two different titles normalized to the same key)** — treat the second occurrence as a distinct entry with a disambiguating suffix appended to the fingerprint. Do not merge silently.
- **Metrics partially supplied** — evaluate the signals whose inputs are present; mark the others `not evaluated: metrics missing`. Never fabricate missing metrics.

## References

- `references/dod-template.md` — the six-item Definition of Done interview.
- `references/triage-categories.md` — full definitions of the four categories with curl-retrospective examples.
- `references/stop-signals.md` — the five stop signals, thresholds, required inputs, and output format.
- `references/output-samples.ja.md` — 日本語で render する場合の triage table / ledger / stop signal footer 例。
