# Triage Categories

The four categories every finding is classified into. These categories are deliberately domain-independent — they work for feature-bug reviews, refactors, planning docs, or infra changes. Each category names the action, not the finding's shape, so the triage is decisive.

## Decision Order

Evaluate each finding in this order. The first match wins.

1. **must-fix / security check** → `must-fix` if the finding names a violation of a DoD required feature, quality bar, or security property. This check runs **first** so a later cycle's clearer DoD, changed context, or security interpretation can rescue a finding whose fingerprint already sits in the rejected ledger. A security-relevant or required-feature-violating finding is NEVER suppressed by a prior ledger entry.
2. **Ledger lookup** → `reject-noise: already-rejected` if the fingerprint is in the rejected ledger AND the finding did not fire `must-fix` in step 1. Reuse the ledger's prior redacted reason without paraphrasing.
3. **out-of-scope check** → `reject-out-of-scope` if the finding targets a DoD explicit out-of-scope item, proposes new functionality not in DoD, or asks for production-grade hardening outside `resolved_project_context`
4. **noise check** → `reject-noise` if the finding is a vague suggestion, a niche edge case, implementation detail on a plan target, or self-induced refinement identifiable from prior applied-fix surfaces
5. **fall-through** → `minimal-hygiene` (the default for leaked findings that are neither bugs in DoD scope nor safe to ignore). When `dod` is `null`, the fall-through still lands here — the skill preserves the 4-category invariant. The caller surfaces a degraded-mode warning in the summary footer so the user knows scope triage was weakened, but no new bucket is created.

Yo-yo prevention matters, but not at the cost of silently dropping must-fix bugs. By running must-fix/security before ledger lookup, the skill preserves the "security always wins over scope" rule stated later in this document. A ledger entry that re-fires as must-fix surfaces normally in the user-selection UI (classified `must-fix`, not `reject-noise: already-rejected`), so the user gets to apply or decline it like any other must-fix finding — no "override path" needed.

**Validity is not scope.** A finding can have a true premise and still be `reject-out-of-scope` or `reject-noise`. The validity check answers "is codex describing the artifact accurately?" This triage answers "should this run adopt the recommendation?" Do not shortcut `valid` or `partially-valid` to `must-fix`; every valid finding still passes through the four-category decision order above.

**Project context is a scope input, not an inference.** Use `resolved_project_context` to interpret production-grade findings. The value may be supplied by the caller or resolved before triage from explicit user language, the confirmed DoD, or a confirmed plan. A finding asking for release runbooks, CI gates, dashboards, recovery procedures, or rollout controls can be correct for a production service and still be out of scope for a personal mod, hobby project, or small one-file documentation plan. Do not infer `production service` from codex severity alone.

## The Four Categories

### 1. `must-fix`

**What it contains**: any finding whose fix protects a DoD required feature, quality bar, or security property.

Canonical sub-types:

- **Core feature bug** — a DoD required feature does not work for a DoD supported input. Example: "Chrome copy-as-cURL with Authorization header loses the `Bearer` prefix."
- **Round-trip bug** — Reqoria's own exporter output fails re-import through the same skill's importer. Round-trips are almost always a DoD quality bar.
- **Security-relevant** — credential leak, TLS downgrade, auth scheme downgrade, path traversal, injection. These are `must-fix` even when the affected flag is out of scope, because the DoD quality bar typically includes "no silent security hijack".
- **URL / state hygiene** — out-of-scope flag values leak into URLs or other shared state. Fix scope: value consume + warn. Do NOT escalate to implementing the flag's semantics.

**Action**: fix in the current cycle. Added to `must-fix` bucket in the user confirmation UI with recommended action `Apply fix`.

### 2. `minimal-hygiene`

**What it contains**: findings that point out a real hygiene problem around an out-of-scope feature, where the minimal correct response is **consume the flag's value and warn**, not implement the feature.

This category exists specifically to prevent the most common drift pattern: reviewer says "flag X is broken here" → implementer reads it as "implement flag X" → fully implements X → discovers X was out of scope → reverts X. The correct reading was "stop X's value from polluting the URL slot by consuming and ignoring it".

Typical examples from the curl retrospective:

- `--json`: value consume + POST default. Do NOT implement `Content-Type: application/json` injection or body mode switching.
- `--url-query`: value consume. Do NOT implement query_params re-routing or `+` passthrough.
- `--aws-sigv4`: value consume + non-Basic scheme detection. Do NOT implement SigV4 signing.

**Action**: apply a minimal 1-line hygiene fix in the current cycle. In the user confirmation UI this appears alongside `must-fix` with recommended action `Apply 1-line hygiene`. The rationale column carries the phrase `minimal hygiene only, semantics NOT implemented`.

### 3. `reject-out-of-scope`

**What it contains**: findings that propose implementing a feature, behavior, or edge case that appears in the DoD explicit out-of-scope list, or proposes any feature that does not appear in the DoD required features list.

Canonical sub-types:

- **Semantic implementation proposal** — codex recommends implementing the full semantics of an out-of-scope feature. Example: "Implement `--digest --basic` last-wins ordering."
- **New-feature proposal** — codex suggests adding a feature that was never in scope. Example: "Add Multipart file reading in cURL import."
- **Priority-resolution proposal on tangential methods** — codex suggests logic for methods the change was not supposed to handle. Example: "Route WebDAV `PROPFIND` correctly."
- **Out-of-context production hardening** — codex recommends release runbooks, CI gates, operational recovery procedures, density dashboards, or production-grade rollout controls that the user did not ask for and the DoD does not require. These can be true in a larger production setting and still exceed the current user's context (for example a personal mod or small documentation plan).
- **Heavy test infrastructure for an optional proof** — codex recommends adding dynamic fixtures, integration harnesses, or cross-platform registrations when a smaller acceptance proof already satisfies the DoD. Treat the finding as out of scope unless the DoD names that harness as a required feature or quality bar.

**Action**: reject. Add to the rejected ledger with the post-overlay redacted reason. Do NOT apply any code change for this finding. The next cycle's `<review_context>` (when called from codex-review-cycle) will forward this rejection so codex is asked not to re-report it.

### 4. `reject-noise`

**What it contains**: findings that do not name a concrete failure mode, describe a niche edge case with no typical-user impact, or duplicate a previously-rejected finding.

Canonical sub-types:

- **Vague suggestion** — "Consider adding retry logic", "You might want to validate this". No named failure mode.
- **Niche edge case** — a failure mode real users almost never hit. Example: "Mixed `--data-urlencode 'a%26b=x'` plus a trailing `=`"
- **Already rejected** — fingerprint matches an entry in the rejected ledger. Re-using the prior rationale prevents yo-yo re-litigation.
- **Plan target detailed-design** — on a plan target, a finding about pseudo-code, field mutability, method signatures, or wording.
- **Self-induced refinement** — a later-cycle finding that only polishes or elaborates text, tests, fixtures, runbooks, or policy introduced by the previous cycle's accepted fix, without exposing a new DoD violation. Use the caller's prior-cycle `applied_fixes[]` surfaces (`touched_files[]` and `phase_6_note`) when available; if history is too thin, do not guess. Treat it as noise or as evidence that the previous cycle's fix should be rolled back, not as automatic justification for another expansion.
- **Redundant specification split** — a true observation already represented by an existing success criterion, equivalence dimension, or accepted divergence. Prefer a one-line clarification only when needed; otherwise reject the duplicate.

**Action**: reject. Add to ledger (or increment count if already present). The user may override a specific reject-noise if they disagree, but the default is dismissal.

## curl retrospective — concrete examples

The original curl import session surfaced these classifications in practice:

| Finding | Category | Rationale |
|---------|----------|-----------|
| UTF-8 mojibake in header values | `must-fix` | Core feature bug on Chrome typical paste |
| Empty token preservation in quoted strings | `must-fix` | Core path correctness |
| Cookie file detection and warn | `must-fix` | Security: avoid silent credential source switch |
| `--aws-sigv4 value consume + non-Basic scheme detection` | `must-fix` | Security: auth scheme degradation |
| `--json value consume + POST default` (1-line fix) | `minimal-hygiene` | Hygiene for out-of-scope flag; semantics NOT implemented |
| `--url-query value consume` (1-line fix) | `minimal-hygiene` | Hygiene only |
| `--json` shorthand full implementation (CT / Accept / body mode) | `reject-out-of-scope` | DoD explicit out-of-scope: cURL 7.82+ new semantics |
| WebDAV `PROPFIND` priority resolution | `reject-out-of-scope` | DoD explicit out-of-scope: WebDAV methods |
| `--digest --basic` last-wins (cycles 2, 3, 4) | `reject-noise` (already-rejected from cycle 1) | Ledger hit; prior rationale: auth scheme last-wins is niche |
| "Consider adding retry logic" (no specific failure named) | `reject-noise` | Vague, no concrete failure mode |
| `a%26b=x` + trailing `=` mixed-flag edge case | `reject-noise` | Niche edge case; no typical-paste user impact |

The classification is not always obvious. When a finding straddles categories — e.g. a security-relevant fix on an out-of-scope flag — it resolves to `must-fix` (security always wins over scope), applied as `minimal-hygiene`-style 1-line consume without implementing the flag. Document the reasoning in the rationale column so the user can audit.

## When in doubt

Default to `minimal-hygiene`, not `must-fix`. The cost of a 1-line consume + warn is low, and it keeps the URL / state hygiene bar while avoiding scope creep. `must-fix` should be reserved for findings that have a clear DoD anchor.
