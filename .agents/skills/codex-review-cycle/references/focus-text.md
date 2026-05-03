# Focus Text

Canonical focus text passed to `adversarial-review --json` as its trailing argument. Each target kind has one fixed focus text — do not paraphrase per cycle. Per-cycle context travels in the `<review_context>` XML block appended after the focus text (see "Context Composition" below).

## Target Kind Detection

Resolve once at Phase 0 from the chosen `review_target.diff_command` output (plus the untracked list from `git ls-files --others --exclude-standard` when `review_target.scope == working-tree`):

- `code` — diff contains at least one file with a code extension: `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.py`, `.go`, `.rs`, `.java`, `.kt`, `.kts`, `.c`, `.cc`, `.cpp`, `.h`, `.hpp`, `.cs`, `.swift`, `.rb`, `.php`, `.sh`, `.bash`, `.zsh`, `.sql`, `.yaml`, `.yml`, `.toml`, `.json`, `.gradle`, `Dockerfile`. Unknown extensions default to `code`.
- `plan` — diff contains only `.md`, `.markdown`, or `.txt` files.
- Mixed (any code file present) is treated as `code`. The validity check still filters out detailed-design findings on markdown files via item 6 in `validity-checklist.md`.

## Code Focus Text

Pass this exact text when the target kind is `code`:

```
Focus on correctness, security, resource management, error handling, and race conditions in the diff. Ground every finding in a specific changed line. Prefer concrete bugs and verifiable risks over stylistic suggestions or speculative refactors.
```

The "ground every finding in a specific changed line" clause steers codex away from meta-commentary toward file-and-line findings the validity check can evaluate.

## Plan Focus Text

Pass this exact text when the target kind is `plan`:

```
Review this planning document at the SPEC/DESIGN level only. Focus on: feasibility blockers, unproven assumptions, missing test hooks, behavioral equivalence risks, hidden stop conditions, recovery/rollback gaps, and scope items that are actually out of scope. Do NOT produce implementation-detail nitpicks, pseudo-code suggestions, field-mutability comments, enum completeness checks, specific method signature recommendations, or naming/wording improvements. Those belong to the implementation phase, not the plan phase. Stay above the "would a senior reviewer raise this in a design meeting?" bar — if the finding is too fine-grained for a design review, omit it.
```

Two-layer defense: the focus text tells codex what not to produce upstream; the validity check in `validity-checklist.md` (item 6) still rejects any detailed-design nitpicks that leak through downstream.

## Scope

The codex CLI flags are computed once in Phase 0 from `review_target.scope` and reused across all cycles:

- `working-tree` → `--scope working-tree` (no `--base`)
- `branch` → `--base <review_target.base_sha>` (frozen SHA resolved at Phase 0 from the auto-detected default branch; NOT `base_ref`, which is mutable)
- `base-ref` → `--base <review_target.base_sha>` (frozen SHA resolved at Phase 0 from the user-supplied ref: any commit SHA, tag, or branch name)

Never use `--scope auto` — the skill requires deterministic targeting so the same diff is reviewed across cycles.

## Context Composition

The full trailing argument passed to `adversarial-review --json` is:

```
<target-kind focus text>

<review_context block — see SKILL.md §Review Context Format>
```

Separate the two sections with a single blank line. The `<review_context>` block carries the change intent, prior-cycle fixes, and rejected findings so codex keeps its review angle consistent across cycles. On cycle 1 the block contains only `<intent>`.

## Do Not Modify Per Finding

The focus text is a cycle-level configuration, not per-finding steering. Claude never rewrites it mid-cycle. If a finding needs a different angle, let the validity check reject it or let the user decline it — the rejection flows into the next cycle's `<review_context>` so codex stops re-reporting it.
