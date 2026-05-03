# Summary Output Template

**Language pre-render gate (mandatory first step)**: before writing any of the summary output, determine the user's output language (conversation language or system configuration) and apply the translation contract in SKILL.md §Language. Every non-verbatim element below — heading text, bullet labels, `Recommended action` values, stop-signal footer prose, fleet-rate warnings — MUST render in that language. The English labels in the template below (`Claude's note`, `Recommended action`, `Cycle N review summary`, etc.) are **placeholders for spec readability only**; rendering them verbatim into a non-English conversation is a Language section violation. See `references/summary-samples.ja.md` for a Japanese example that applies this contract end to end.

**Finding-block format is mandatory.** Do NOT fall back to (a) a wide multi-column Markdown table — it wraps badly when titles are long — nor (b) a label-per-line vertical block with `──────` separators — it has no visual hierarchy and inflates each finding to 8+ lines.

Render after every cycle, before the user selection prompt:

```markdown
### <Cycle-N-review-summary translated> (variant: <review|adversarial-review>, target: <code|plan>)

#### F1 · high · must-fix · valid — <codex title verbatim>
- **<File label translated>**: `src/auth/login.ts:42`
- **<Claude-note label translated>**: <Claude's note body translated; ≤20 words>
- **<Recommended-action label translated>**: <Apply fix translated>
- **<codex-recommendation label translated> (verbatim)**: <codex recommendation field verbatim>

#### F2 · medium · reject-noise · partially-valid — <codex title verbatim>
- **<File label>**: `src/api/user.ts:88`
- **<Claude-note label>**: <translated: vague, no concrete failure mode>
- **<Recommended-action label>**: <Skip translated>
- **<codex-recommendation label> (verbatim)**: <codex recommendation field verbatim>

#### F3 · low · reject-noise · invalid — <codex title verbatim>
- **<File label>**: `docs/plan.md:15`
- **<Claude-note label>**: <translated: detailed-design on plan target>
- **<Recommended-action label>**: <Skip translated>
- **<codex-recommendation label> (verbatim)**: <codex recommendation field verbatim>

**<Active-stop-signals heading translated>** (footer rendered when ≥1 signal is `ADVISORY`/`ACTIVE`/`WARNING` **or** `not evaluated: metrics missing`; omit entirely only when all signals are truly `silent`. When only `not evaluated` rows exist, replace the full table with a compact one-liner `<Not-evaluated-metrics-missing label translated>: <names>`):

| <Signal label> | <Status label> | <Evidence label> |
|----------------|----------------|------------------|
| ...            | ...            | ...              |

⚠️ <N> redactions applied to verbatim content this cycle (categories: <comma-list of <type> values>; <S> from scope triage, <C> from caller render).
```

(The cascade-guard summary line is NOT emitted at this template — see below.)

The footer redaction summary line renders only when `<S> + <C> >= 1` (sum of scope-guard's overlay count `<S>` returned at SKILL.md step 10a + the caller-side overlay count `<C>` applied at SKILL.md step 11). `<N> = <S> + <C>`. The inner `<S>` / `<C>` breakdown is debug attribution so the caller-side path's effectiveness is independently auditable.

**Cascade-guard summary line is emitted at SKILL.md step 15a, NOT at step 11's summary render.** Step 11 runs before user selection (step 13) and before guard invocation (step 13.6 / 13.7), so `guard_receipts[]` and `batch_receipt` are still empty at step 11 — rendering the cascade-guard line here would always show zeros. The line:

```
🛡️ Cascade-guard: <P> findings applied (<C> closed, <R> accepted-residual), <B> blocked (<gate-status-breakdown>), <D> split-deferred; invocation_mode=<registered | manual-fallback | mixed>; batch_gate_status=<value | n/a>.
```

renders at step 15a (after step 15's `cycle_history` persist, before step 16's loop check). Emit it when `selected_count > 0`; omit it on V == 0 cycles and when the user picked `None — skip all` at step 13.

Counts come from final cycle outcomes, not raw receipt status:

- `<P>` = applied findings: receipt editable and F-id not in `batch_envelope.splits[]`.
- `<B>` = blocked findings: receipt non-editable, including `manual-fallback` receipts missing matrix / validation evidence.
- `<D>` = split-deferred findings: receipt editable but deferred by batch split.
- `<U>` = `V - selected_count`, rendered only when positive as `<U> user-declined-at-selection (V=<V>)`.

A receipt is editable only when `gate_status ∈ {closed, accepted-residual}` and, for `manual-fallback`, both evidence flags are true. Invariants: `<P> + <B> + <D> = selected_count`; when `<U>` is present, `<P> + <B> + <D> + <U> = V`. `invocation_mode` reads `mixed` when receipts have both `registered` and `manual-fallback` values; `batch_gate_status` shows `n/a` when Phase 5.5 produced no carry record. This line surfaces per-finding `Cascade Guard — F<n>` envelope results that otherwise live only in `cycle_history`.

## Heading-line anatomy

Each finding heading encodes four identifiers plus the verbatim title in a single line so the user can scan findings without reading each body:

```
#### F<n> · <severity> · <scope> · <validity> — <codex title verbatim>
```

- **`F<n>`** — cycle-local finding ID.
- **`<severity>`** — codex severity keyword (`high` / `medium` / `low`). Verbatim.
- **`<scope>`** — `review-scope-guard` triage category (`must-fix` / `minimal-hygiene` / `reject-out-of-scope` / `reject-noise`). Verbatim.
- **`<validity>`** — validity check outcome (`valid` / `partially-valid` / `invalid`). Verbatim.
- **`<codex title verbatim>`** — codex `title` field. Emitted in the post-overlay redacted form per `review-scope-guard` SKILL.md §Secret Hygiene. The verbatim contract is preserved within the redacted form: non-secret prose is byte-identical, secret matches become `[REDACTED:<type>]` per scope-guard §Verbatim contract precedence. Never translated, paraphrased, or shortened.

The middle dot (`·`, U+00B7) is a visual separator only; do not replace with `|`, `,`, or `-`.

## Body-bullet rules

Every finding body contains exactly four bullets in this order:

1. **File:Line** — always first. Format as ` `` `-wrapped `<file>:<line_start>` so the path renders in a monospace font. When codex did not cite a line, render as `<file> (line: n/a)`.
2. **Claude's note** — ≤20-word sentence in the user's language, anchored on the validity check's rationale. Required for every finding, including `invalid` and `reject-*`.
3. **Recommended action** — short translated phrase. Canonical values (illustrative in English): `Apply fix`, `Apply 1-line hygiene`, `Skip`, `Skip (ledger fwd)`.
4. **Codex recommendation (verbatim)** — codex's `recommendation` field, quoted verbatim below the bullet label. Emitted in the post-overlay redacted form per `review-scope-guard` SKILL.md §Secret Hygiene; the verbatim contract is preserved within the redacted form (see scope-guard §Verbatim contract precedence). The bullet label text is translated, but the quoted recommendation body is never translated, paraphrased, or truncated. This replaces the old bottom-of-summary `Recommendation (per finding)` block — embedding the recommendation inside each finding removes cross-referencing and keeps findings self-contained.

### Verbatim recommendation containment

The fourth bullet's quoted body is arbitrary codex output. It may span multiple paragraphs, contain Markdown list markers (`-`, `*`, `1.`), embedded code fences, nested backticks of arbitrary length, or headings. Leaked Markdown inside the recommendation would render as extra visual bullets or new headings, breaking both human scanning and golden-output parsing. The containment rule below keeps the 4-bullet structural invariant intact regardless of recommendation shape:

- **Single-line recommendation (no leading Markdown marker, no backticks)** — quote inline after the label:

  ```markdown
  - **codex recommendation (verbatim)**: <recommendation on one line>
  ```
- **Multi-line recommendation, OR any line that would start with `-`, `*`, `>`, `#`, ` `, or a numbered-list marker, OR any recommendation containing backticks** — drop into a **fenced code block with an escape-safe fence length**. Compute the longest consecutive backtick run anywhere in the recommendation body; call this `maxRun` (minimum 2 — never emit a shorter fence than 3). The opening and closing fence MUST be `(maxRun + 1)` backticks, so no line inside the recommendation can close the wrapper early. A fixed 3-backtick fence is forbidden: any ```` ``` ```` inside the recommendation would close the wrapper on the inner fence, and later text would render as real headings or bullets.

  Language hint is optional; use `text` when omitted. Example with an embedded 3-backtick code fence inside the recommendation (maxRun = 3, wrapper uses 4 backticks):

  `````markdown
  - **codex recommendation (verbatim)**:
    ````text
    Paragraph 1.
    - list item inside codex output
    Example CLI:
    ```
    codex review --base HEAD~1
    ```
    - another list item
    ````
  `````

The escape-safe fenced block preserves the recommendation byte-for-byte, keeps every Markdown marker — including deeper-nested fences — inside the wrapper, and keeps the "exactly 4 bullets" invariant scannable. When in doubt, use the fenced form with `(maxRun + 1)` backticks.

**Golden cases**: (a) no backticks — 3-backtick fence or longer is fine; (b) a `` ` `` run of 3 in the body — wrapper MUST be 4; (c) a `` ` `` run of 5 — wrapper MUST be 6; (d) `##` headings or `- ` at line start — wrapper required regardless of backtick content.

## Finding order

Group findings by `<scope>` in this order: `must-fix` → `minimal-hygiene` → `reject-out-of-scope` → `reject-noise`. Within a scope, sort by severity (`high` → `medium` → `low`). Within a severity, preserve codex's original ordering. Grouping puts selectable findings at the top so the user does not scroll past rejections to find actionable items.

## Format rules that protect finding intent

- The codex `title` in every heading is verbatim within the §Secret Hygiene redacted form (see `review-scope-guard` SKILL.md §Secret Hygiene → §Verbatim contract precedence) — no paraphrase, no shortening, no translation outside the redaction substitution.
- The codex `recommendation` inside each finding's last bullet is verbatim within the §Secret Hygiene redacted form, regardless of length. Never truncate, summarize, or abbreviate.
- Claude's interpretation lives only in the `Claude's note` and `Recommended action` bullets. Do not edit the heading title or the verbatim recommendation based on what Claude thinks the finding "really means".
- If Claude judges a finding `invalid`, the block still renders with the original heading and recommendation. The `Claude's note` bullet carries `invalid because <reason>` (translated).
- If `review-scope-guard` classifies a finding as `reject-out-of-scope` or `reject-noise`, the block still renders for audit. The heading's `<scope>` segment carries the category; the `Claude's note` carries the triage rationale from the skill's output.
- Severity values come from codex. Do not upgrade or downgrade based on Claude's validity or scope verdict.
- Fleet-rate warnings (see `SKILL.md` Phase 1 step 11) render AFTER the last finding block, not inside any finding.
