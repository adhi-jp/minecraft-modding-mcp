# Definition of Done — Interview Template

The interview the skill runs on first invocation to establish the scope anchor. Every triage decision later in the session refers back to the answers collected here. Collect the six items in order via `AskUserQuestion`, one question per item.

## Why this comes first

The largest source of wasted review cycles is **not having an explicit acceptance bar before review starts**. Without a Definition of Done, every codex finding looks equally valid, so the implementer chases edge cases and semantic implementations that were never in scope. Collecting the six items upfront lets the triage step dismiss out-of-scope findings mechanically instead of re-deciding each time.

If the user declines to answer any item, record `(not specified)` and continue. Skipped items simply widen the "unknown-scope" surface — they do not block the triage step. They do, however, reduce the quality of `reject-out-of-scope` decisions, so warn the user once when ≥2 items are blank.

## The Six Items

### 1. Intent

**Question**: `What is the one-sentence intent of this change?`

Expected form: one sentence, ≤30 words. Names the change goal, not the implementation approach. Example: `Add cURL-command import so users can paste Chrome/Firefox/Postman copy-as-cURL output and get a request in Reqoria.`

### 2. Supported Inputs

**Question**: `Which input sources must this change handle correctly?`

Expected form: a bulleted list of concrete sources. Example:

- Chrome DevTools "Copy as cURL (bash)"
- Firefox DevTools "Copy as cURL"
- Postman "Code snippet → cURL"
- Hand-written typical `curl` commands (`-X`, `-H`, `-d`, `-u`, `-k`, `-m` only)

Use these sources later as the anchor for `must-fix` decisions: if a finding says a typical Chrome paste breaks, it is a bug against this item.

### 3. Required Features

**Question**: `Which features / flags / endpoints must work? List the must-have set.`

Expected form: a bulleted list. For feature work on an existing surface, include the specific flags or methods. Example:

- Methods: `-X` / `-I`
- Headers: `-H`
- Body: `-d` / `--data` / `--data-raw` / `--data-binary` / `--data-urlencode`
- Auth: `-u`
- Conveniences: `-A` / `-e` / `-b`
- TLS/timing: `-k` / `-m`
- Round-trip: `-L` / `--max-redirs` / `--referer ';auto'`

### 4. Explicit Out-of-Scope (most important item)

**Question**: `Which features, flags, or behaviors are explicitly out of scope? List the tempting extensions you want to rule out.`

Expected form: a bulleted list of named items.

**Strong requirement**: list at least 3 items, and for each item, name a *sibling* feature that sits next to it in the code path but is **in scope**. A vague out-of-scope list is the single most common reason `reject-out-of-scope` decisions collapse to `minimal-hygiene` fall-through. If you cannot name 3 tempting extensions, the change is either too small to need this skill (use the codex plugin directly) or the scope has not been thought through yet. Examples of sibling-framing: "cookie_store crate migration (out) — sits next to reqwest::cookie::Jar basic use (in)"; "env/session-scoped Jar partitioning (out) — sits next to single-process Jar sharing (in)".

The explicit out-of-scope list is the single most important item for the triage step. It is the list against which `reject-out-of-scope` decisions are made. Example:

- cURL 7.80+ new features (`--json`, `--url-query`, `--aws-sigv4`) — semantic implementation
- WebDAV methods (`PROPFIND`, etc.) — priority resolution
- Multipart (`-F`) — physical file write-out
- FTP / SMTP / Telnet flags
- Auth scheme last-wins (`--digest --basic` ordering)

If the user gives a narrow list here but the change area has obvious tempting extensions, prompt once for additional items (`Are there cURL 8.x features you also want to rule out?`).

### 5. Quality Bars

**Question**: `What are the non-negotiable quality bars for this change?`

Expected form: a bulleted list of verifiable properties. Example:

- Chrome/Firefox/Postman typical output imports 100%
- For supported flags, wire bytes match the source command
- No silent URL / auth / TLS hijack even for out-of-scope flags (security bar)

These become the anchors for `must-fix` on security and round-trip findings.

### 6. Accepted Divergences

**Question**: `Which cases are you explicitly willing to ship as best-effort or approximate?`

Expected form: a bulleted list of acceptable losses. Example:

- Mixed flags (`--data-urlencode` + `--data-raw`) — byte-exact match is best-effort
- WebDAV methods — "warn + ignore", fall back to GET/POST

These items tell the triage step to dismiss findings that complain about already-accepted approximations.

## Collection Modes

The skill supports four ways to collect the six items — all must produce the same structured DoD:

1. **Interview** — one `AskUserQuestion` per item. Safest when the diff is large or the user's intent is ambiguous.
2. **Proposal** — Claude drafts all six items from available context (diff, commit messages, the ongoing conversation) and posts them as one markdown block. The user confirms with `ok` or pastes inline edits. Allowed for ≤ ~100 LOC diffs that also pass the evidence gate (see Detailed mode rules below). Proposal mode must never auto-fill item 4 without sibling-framed examples; when evidence is thin, fall back to Interview mode for item 4.
3. **Free-text** — the user pastes a pre-written DoD. Claude splits it into the six items, then runs a single `AskUserQuestion` confirming item 4 meets the sibling-framing rule in §4.
4. **Quick** — one `AskUserQuestion` covering only item 4 (Explicit Out-of-Scope). Items 1/2/3/5/6 default to `(not specified)`. Use when the user explicitly requests "quick DoD" on a trivial change (≤ ~30 LOC). Item-4 completeness gate still applies; <3 sibling-framed items enters degraded mode as usual.

Regardless of mode, echo the final DoD back as a numbered list so the user can audit before triage runs.

### Detailed mode rules

1. **Interview** — default when diff characteristics are unknown or DoD clarity is ambiguous. Always produces a complete DoD.
2. **Proposal** — allowed only when the caller passed `review_target` AND the evidence gate passes:
   - Working-tree: non-empty `diff_patch_excerpts` (filename+numstat alone insufficient).
   - Branch/base-ref: at least one commit with ≥20-char subject AND non-empty body, OR `diff_patch_excerpts` populated from the target commit range.
   - LOC threshold: `diff_numstat` totals ≤ ~100.
   Fall back to interview when the evidence gate fails. Input contract: proposal mode MUST source its diff/commit-message facts from `review_target` only; it MUST NOT infer from ambient git state (that would make the scope classifier circular — the DoD would be derived from the same diff it is supposed to judge).
3. **Free-text** — triggered when the user pastes a DoD block in the conversation. Split into six items by heading/numbering, run one confirmation `AskUserQuestion` for item 4.
4. **Quick** — triggered when user explicitly says "quick DoD" / "minimal DoD" / similar AND diff is ≤ ~30 LOC. Single `AskUserQuestion` collecting item 4 only, with label `Out-of-scope (≥3 sibling-framed items) — this is the minimum that keeps the scope guard active.` Other items default to `(not specified)`; the ≥2-blank warning is expected and suppressed.

Regardless of mode, the item-4 completeness gate in `review-scope-guard/SKILL.md` Phase 0 step 2b runs and may enter degraded mode if item 4 has <3 sibling-framed entries (with user override available).

## After Collection

Echo the full six-item DoD back to the user once as a numbered list, then proceed to Phase 1 findings normalization. The DoD stays in-session; it is not written to disk unless the user explicitly asks for a persistent file. Subsequent calls to the skill within the same conversation reuse the DoD without asking again.
